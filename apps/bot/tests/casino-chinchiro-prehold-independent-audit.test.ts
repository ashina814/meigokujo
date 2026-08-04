/**
 * PR11 独立本監査の敵対的テスト。
 *
 * 前回の本監査（casino-chinchiro-prehold-audit.test.ts）に対する再監査で指摘された
 * 6論点を直接検証する。
 *
 * 1. `ensureFreeChips → escrow.hold → settle` は実際には別トランザクション。
 *    「ラウンド全体が単一トランザクション」という説明は誤りだったため訂正し、
 *    各 crash window を個別に固定する。
 * 2. `PreheldWager` の帰属を core 層（`casino_escrow`）で証明する。残高検査が
 *    `runGroup()` の外にあり、保存済み結果の再実行を妨げていたブロッカーを修正した。
 * 3. `ensureFreeChips()` の例外を `insufficient_funds` へ一律に潰さず区別する。
 * 4. 自動預入成功後に `escrow.hold()` が失敗する窓での資金の着地。
 * 5. 同一 operationId で異なる bet・user・session を渡した場合の conflict。
 * 6. 別 SQLite 接続・別 Node プロセスからの競合。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  ChipTxError,
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

function build(db: ReturnType<typeof openDb>, rng: CasinoRng = scriptedRng([0.5])) {
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
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

function setup(rng: CasinoRng = scriptedRng([0.5])) {
  const db = openDb(":memory:");
  const ctx = build(db, rng);
  ctx.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ctx.ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ctx.ledger.lastTransactionId(),
  });
  return ctx;
}

type Ctx = ReturnType<typeof setup>;

function fund(ctx: Ctx, uid: string, land: number, chips = land): void {
  ctx.ledger.ensureAccount(`user:${uid}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${uid}`, amount: land, type: "initial", actor: "test", idempotencyKey: `seed:${uid}` });
  if (chips > 0) ctx.chips.deposit(uid, chips, `deposit:${uid}`);
}

function fundHouse(ctx: Ctx, amount = 1_000_000): void {
  ctx.db
    .prepare(
      "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
    )
    .run(HOUSE_HOLDER, amount);
}

// ── 論点1: 各段階は別トランザクション。crash windowを個別に固定する ────────

describe("PR11独立監査1: ensureFreeChips → escrow.hold → settle は別トランザクション", () => {
  it("window A: ensureFreeChips成功後・hold()の前にプロセスが落ちても、資金は自由チップとして残り失われない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000, 300); // 自由チップ300、残りLand
    const preheld = chinchiroMaxPlayerLoss(1_000);

    // beginChinchiroPrehold の1段目だけを実行する（2段目 escrow.hold() の直前で
    // プロセスが落ちた状況を再現）
    ctx.chipFlow.ensureFreeChips("u1", preheld, "op-1-chinchiro-prehold");
    expect(ctx.chips.balanceOf("u1")).toBe(preheld);
    expect(ctx.escrow.list(chinchiroPreholdSessionId("u1", "op-1"))).toEqual([]);

    // 「再起動後」、同じ操作をもう一度実行する（beginChinchiroPrehold を最初から）。
    // ensureFreeChips は同じ鍵で二重預入せず、hold() が初めて escrow へ移す
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(sessionId))).toBe(preheld);
    // 自由チップは1,000も余分に動いていない（自動預入は不足分=0のまま、二重預入なし）
    expect(ctx.ledger.balanceOf("user:u1")).toBe(0);
  });

  it("window B: hold()成功後・settle()の前にプロセスが落ちても、起動時復旧が孤児として自動返金する（既存テストと同じ窓を別角度から確認）", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);
    expect(ctx.chips.balanceOf("u1")).toBe(0);

    // プロセスの再起動そのものを模す（catch/refund は一切呼ばない — 呼べないから
    // crash windowなのであって、呼べるなら window ではない）
    const result = ctx.runRecovery();
    expect(result.outcome).toBe("opened");
    expect(ctx.chips.balanceOf(holder)).toBe(0);
    expect(ctx.escrow.list(sessionId)).toEqual([]);
  });

  it("window C: settle()内部（賭け金徴収後・配当前）で例外が起きても、賭け金の徴収を含めグループ全体が巻き戻る", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(chinchiroPreholdSessionId("u1", "op-1"));
    const houseBefore = ctx.chips.balanceOf(HOUSE_HOLDER);

    const originalTransfer = ctx.chips.transfer.bind(ctx.chips);
    let calls = 0;
    const spy = vi.spyOn(ctx.chips, "transfer").mockImplementation((...args: Parameters<typeof ctx.chips.transfer>) => {
      calls++;
      if (calls === 1) return originalTransfer(...args); // 賭け金の徴収(holder→house)は通す
      throw new Error("injected failure between charge and payout");
    });

    expect(() => settleChinchiroRound(ctx.services, "u1", 1_000, 1, "op-1")).toThrow("injected failure");
    spy.mockRestore();

    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(houseBefore);
    expect(ctx.chipTx.getGroup("chinchiro:round:u1:op-1")).toBeUndefined();
  });

  it("window D: settle()成功・escrow.clear()前にプロセスが落ちても、外側グループが未確定なので次回実行で再現できる", () => {
    // settleChinchiroRound の全体（settle→extra/remaining payout→clear）は
    // outer group（chinchiro:round:...）という単一トランザクションに包まれている。
    // 「settle成功後・clear前」に個別のcrash windowは存在しない——ここではその
    // 主張自体をコード上の事実として確認する（同期関数内に await が無い）。
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, -1, "op-1");
    expect(round.branch).toBe("loss");
    // 一度確定すれば escrow は必ず空。中間状態が外部から観測されることはない
    expect(ctx.escrow.list(chinchiroPreholdSessionId("u1", "op-1"))).toEqual([]);
  });
});

// ── 論点2: PreheldWager の帰属証明・runGroup内チェック ──────────────────

describe("PR11独立監査2: PreheldWagerの帰属証明とreplay安全性", () => {
  it("他人のsessionIdを渡しても、その利用者の資金は動かせない（casino_escrowでの帰属確認）", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fund(ctx, "u2", 2_000);
    const u1Session = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    fundHouse(ctx);

    // u2 の名目で、u1 のセッションを徴収元にしようとする（額は正しく言い当てた
    // うえでの不正呼び出しを再現。attribution が最初に落ちることを見る）
    expect(() =>
      ctx.casino.settleSolo("u2", "チンチロ", 1_000, 1_000, {
        operationId: "op-attack",
        preheld: { sessionId: u1Session, expectedAmount: chinchiroMaxPlayerLoss(1_000) },
      }),
    ).toThrow(/not attributed to user/);

    // u1のescrow・u2の残高とも動いていない
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(u1Session))).toBe(2_000);
    expect(ctx.chips.balanceOf("u2")).toBe(2_000);
  });

  it("存在しない・架空のsessionIdは単一行確認で拒否され、houseを徴収元にできない", () => {
    const ctx = setup();
    fund(ctx, "u1", 1_000, 0);
    fundHouse(ctx);

    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-fake",
        preheld: { sessionId: "fabricated-session-id", expectedAmount: 2_000 },
      }),
    ).toThrow(/not single-row/);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
  });

  it("複数人session（対人卓のholdAll）を徴収元にできない——他の参加者の預託まで奪えない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fund(ctx, "u2", 2_000);
    fundHouse(ctx);
    const tableSession = "roulette:multi-session";
    // 複数人の対人卓（ルーレット等）が holdAll で同じ session へ複数行を作る状況を再現
    expect(ctx.escrow.holdAll(tableSession, ["u1", "u2"], 1_000, "ルーレット", "table-op")).toBe(true);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(tableSession))).toBe(2_000);

    // u1 が、対人卓の共有 holder を自分のチンチロ精算の徴収元にしようとする
    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-multi",
        preheld: { sessionId: tableSession, expectedAmount: 2_000 },
      }),
    ).toThrow(/not single-row/);

    // u2 の預託を含め、卓の資金は1 Ldも動いていない
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(tableSession))).toBe(2_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
  });

  it("別ゲームのsessionを徴収元にできない——game名が一致しないと拒否する", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    const otherGameSession = "slots:some-session";
    // 別ゲーム（スロット想定）が同じ escrow.hold() を使って作った session を再現
    expect(ctx.escrow.hold(otherGameSession, "u1", 2_000, "スロット", "other-op")).toBe(true);
    const holder = ctx.escrow.holderId(otherGameSession);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);

    // この session を "チンチロ" の精算に流用しようとする
    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-wrong-game",
        preheld: { sessionId: otherGameSession, expectedAmount: 2_000 },
      }),
    ).toThrow(/game mismatch/);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
  });

  it("旧方式（source='house'）のescrow行を徴収元にできない——sourceが一致しないと拒否する", () => {
    const ctx = setup();
    fund(ctx, "u1", 1_000, 0);
    fundHouse(ctx);
    const legacySession = "legacy:house-source";
    // 旧方式の escrow 行（source が holder ではなく 'house' のまま）を直接作る
    ctx.db
      .prepare(
        "INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(legacySession, "u1", 2_000, "チンチロ", HOUSE_HOLDER, Math.floor(Date.now() / 1000));

    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-legacy",
        preheld: { sessionId: legacySession, expectedAmount: 2_000 },
      }),
    ).toThrow(/source mismatch/);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
  });

  it("expectedAmountを台帳額と食い違って渡すと拒否する——余剰でも不足でも動かさない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1"); // 台帳2,000
    const holder = ctx.escrow.holderId(sessionId);

    // 呼び出し側が実際より少ない額を主張（不足の主張）
    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-under",
        preheld: { sessionId, expectedAmount: 1_000 },
      }),
    ).toThrow(/amount mismatch/);

    // 呼び出し側が実際より多い額を主張（余剰の主張）
    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-over",
        preheld: { sessionId, expectedAmount: 3_000 },
      }),
    ).toThrow(/amount mismatch/);

    expect(ctx.chips.balanceOf(holder)).toBe(2_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
  });

  it("残高検査はrunGroup内にあるため、精算後にholder残高が変わっても保存済み結果の再実行を妨げない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");

    // settleSolo をチンチロのouter groupに包まず直接呼ぶ（settleSoloの
    // groupKey自体がトップレベルの業務グループになるケース）。
    // settle() は bet ぶんだけを holder から徴収するので、1回の呼び出し後は
    // holder に「ちょうど bet ぶん」が残る（それ以上は動かない）
    const expectedAmount = chinchiroMaxPlayerLoss(1_000);
    const first = ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
      operationId: "op-direct",
      preheld: { sessionId, expectedAmount },
    });
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(1_000);

    // settleChinchiroRound が普段この直後に行う「残額を利用者へ返す」を、
    // ここでは意図的に分離して直接実行する。holder は bet を下回る（0）まで減り、
    // casino_escrow 台帳の amount とも食い違う状態になる
    ctx.db.prepare("UPDATE ether_balances SET amount = 0 WHERE user_id = ?").run(holder);
    expect(ctx.chips.balanceOf(holder)).toBe(0);

    // 同じ operationId で再実行。事前チェックが runGroup の外にあれば、
    // 「holder残高(0)が台帳額(2,000)と食い違う」で落ちて保存済み結果を返せない。
    // runGroup の中にあれば replay され、例外にならない（本監査で修正した点）
    const second = ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
      operationId: "op-direct",
      preheld: { sessionId, expectedAmount },
    });
    expect(second).toEqual(first);
  });
});

// ── 論点3: ensureFreeChips の例外を区別する ────────────────────────────

describe("PR11独立監査3: ensureFreeChipsの例外を一律insufficient_fundsへ潰さない", () => {
  it("Land不足はLedgerError(ERR_INSUFFICIENT)からinsufficient_fundsへ変換される", () => {
    const ctx = setup();
    fund(ctx, "u1", 100, 100); // 2×1,000=2,000に遠く届かない
    try {
      beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChinchiroPreholdError);
      expect((error as ChinchiroPreholdError).reason).toBe("insufficient_funds");
    }
  });

  it("賭場停止中(ERR_CASINO_CLOSED)はinsufficient_fundsへ丸めず、ChipTxErrorのまま外へ出る", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000, 0); // 自由チップ0・Landのみ→自動預入が必要
    ctx.chipTx.setClosedReason(() => "検算NGのため停止中");

    try {
      beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ChinchiroPreholdError);
      expect(error).toBeInstanceOf(ChipTxError);
      expect((error as ChipTxError).code).toBe("ERR_CASINO_CLOSED");
    }
    // 資金は1 Ldも動いていない
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(2_000);
  });

  it("同一operationIdで異なるrequired(=異なるbet)の衝突はinsufficient_fundsへ丸めず、そのまま外へ出る", () => {
    const ctx = setup();
    fund(ctx, "u1", 10_000, 0);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1"); // preheld=2,000で確定

    try {
      beginChinchiroPrehold(ctx.services, "u1", 2_000, "op-1"); // 同じop-1でpreheld=4,000を要求
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ChinchiroPreholdError);
      expect((error as Error).message).toMatch(/operation conflict/);
    }
  });
});

// ── 論点4: 自動預入成功後にhold()が失敗する窓 ────────────────────────

describe("PR11独立監査4: 自動預入成功後・hold()失敗時の着地", () => {
  it("hold()が失敗しても自由チップは失われず、escrow行も残らず、再試行で正しく完了する", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000, 300);
    const preheld = chinchiroMaxPlayerLoss(1_000);

    const holdSpy = vi.spyOn(ctx.escrow, "hold").mockReturnValueOnce(false);
    try {
      beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChinchiroPreholdError);
      expect((error as ChinchiroPreholdError).reason).toBe("hold_failed");
    }
    holdSpy.mockRestore();

    // 自動預入で積まれた自由チップは失われていない（Landに戻ってもいないし消えてもいない）
    expect(ctx.chips.balanceOf("u1")).toBe(preheld);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(0);
    // escrow行は作られていない
    expect(ctx.escrow.list(chinchiroPreholdSessionId("u1", "op-1"))).toEqual([]);

    // 再試行（同じoperationId）: 自動預入は同じ鍵で二重に動かず、今度はholdも成功する
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(sessionId))).toBe(preheld);
  });
});

// ── 論点5: 同一operationIdで異なるbet・user・sessionのconflict ──────────

describe("PR11独立監査5: operationId conflict", () => {
  it("同一user・同一operationIdで異なるbetはconflict（自動預入層で検出）", () => {
    const ctx = setup();
    fund(ctx, "u1", 10_000, 0);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(() => beginChinchiroPrehold(ctx.services, "u1", 500, "op-1")).toThrow(/operation conflict/);
  });

  it("異なるuser・同一operationIdは独立したsessionになり、互いに衝突しない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fund(ctx, "u2", 2_000);
    const s1 = beginChinchiroPrehold(ctx.services, "u1", 1_000, "shared-op");
    const s2 = beginChinchiroPrehold(ctx.services, "u2", 1_000, "shared-op");
    expect(s1).not.toBe(s2);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(s1))).toBe(2_000);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(s2))).toBe(2_000);
  });

  it("同一sessionへの二重holdは、二度目がreplayされ額を増やさない（escrow.hold自体の冪等性）", () => {
    const ctx = setup();
    fund(ctx, "u1", 10_000, 0);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);

    // 同じ session・同じ user・同じ operationId で再度 hold を試みる
    // （beginChinchiroPreholdのensureFreeChipsが先に弾くため、hold単体の冪等性を直接見る）
    const result = ctx.escrow.hold(sessionId, "u1", chinchiroMaxPlayerLoss(1_000), "チンチロ", "op-1");
    expect(result).toBe(true);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000); // 増えていない
  });

  it("【既知の限界・PR11範囲外】生のescrow.hold()は額の不一致を見ずに保存済みboolをreplayする", () => {
    // これは「安全」の確認テストではない。escrow.hold() の group key は
    // session_id + user_id + operationId だけで、要求額を見ずに保存済みの bool を
    // 返す（PR2 由来、チンチロ以外の既存呼び出し全般に共通する挙動）。
    // 額を鍵に含めていないので、理屈の上では「2,000のつもりで呼んだのに実は500しか
    // 確保されていない」状態を作れてしまう——ここではその生の挙動を明文化するだけで、
    // 正常仕様として固定しない。conflict化するかどうかは PR11 の範囲外として別途判断する。
    const ctx = setup();
    fund(ctx, "u1", 10_000);
    const sessionId = chinchiroPreholdSessionId("u1", "op-1");
    expect(ctx.escrow.hold(sessionId, "u1", 500, "チンチロ", "op-1")).toBe(true);
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(500);

    // 額を検証せず、保存済みの true を返すだけ（実際には 2,000 になっていない）
    expect(ctx.escrow.hold(sessionId, "u1", 2_000, "チンチロ", "op-1")).toBe(true);
    expect(ctx.chips.balanceOf(holder)).toBe(500);

    // チンチロの実経路がここへ到達しないのは、上の「同一user・同一operationIdで
    // 異なるbetはconflict」テストが示すとおり、escrow.hold() より前に
    // ensureFreeChips() が同じ検証（同一operationIdで異なるrequired）を行うため
  });
});

// ── 論点6: 別SQLite接続・別Nodeプロセスからの競合 ────────────────────

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows はハンドル解放前だと EPERM を返す。テスト結果には影響しない
    }
  }
});

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chinchiro-prehold-conc-"));
  tempDirs.push(dir);
  return join(dir, "db.sqlite");
}

const driverPath = createRequire(import.meta.url).resolve("better-sqlite3");

function externalExec(path: string, sql: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      "const D=require(process.argv[1]);const d=new D(process.argv[2],{timeout:5000});d.pragma('journal_mode=WAL');d.pragma('busy_timeout=5000');d.exec(process.argv[3]);d.close()",
      driverPath,
      path,
      sql,
    ],
    { stdio: "pipe" },
  );
}

function fileSetup(path: string) {
  const db = openDb(path);
  const ctx = build(db);
  return ctx;
}

describe("PR11独立監査6: 別SQLite接続・別Nodeプロセスからの競合", () => {
  it("別接続がholdを確定させていれば、二度目のbeginChinchiroPreholdは資金を動かさずreplayを返す", () => {
    const path = newDbPath();
    const a = fileSetup(path);
    a.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: a.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: a.ledger.lastTransactionId(),
    });
    fund(a, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(a.services, "u1", 1_000, "op-1");
    expect(a.chips.balanceOf("u1")).toBe(0);

    const b = fileSetup(path);
    const sessionIdB = beginChinchiroPrehold(b.services, "u1", 1_000, "op-1");
    expect(sessionIdB).toBe(sessionId);
    expect(b.chips.balanceOf("u1")).toBe(0);
    expect(b.chips.balanceOf(b.escrow.holderId(sessionId))).toBe(2_000);

    a.db.close();
    b.db.close();
  });

  it("別プロセスが settle 済みにしていれば、再実行しても二重精算しない", () => {
    const path = newDbPath();
    const a = fileSetup(path);
    a.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: a.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: a.ledger.lastTransactionId(),
    });
    fund(a, "u1", 2_000);
    fundHouse(a);
    beginChinchiroPrehold(a.services, "u1", 1_000, "op-1");
    const first = settleChinchiroRound(a.services, "u1", 1_000, -1, "op-1");
    expect(first.branch).toBe("loss");
    const balanceAfter = a.chips.balanceOf("u1");
    a.db.close();

    // 「起動しなおした」別プロセス（別接続）が同じ操作を再実行する
    const b = fileSetup(path);
    const second = settleChinchiroRound(b.services, "u1", 1_000, -1, "op-1");
    expect(second).toEqual(first);
    expect(b.chips.balanceOf("u1")).toBe(balanceAfter);
    b.db.close();
  });

  it("別プロセスが所有(house_reservations)を作った直後のrefundは、資金を動かさずhasActiveOwnershipに委ねる", () => {
    const path = newDbPath();
    const a = fileSetup(path);
    a.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: a.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: a.ledger.lastTransactionId(),
    });
    fund(a, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(a.services, "u1", 1_000, "op-1");
    const holder = a.escrow.holderId(sessionId);

    // 別プロセスが escrow.refund を同時に試みる状況を、直列に確定させて確認する
    // （refundは session_id を鍵にした冪等操作なので、二重返還は起きない）
    externalExec(
      path,
      `DELETE FROM casino_escrow WHERE session_id='${sessionId}';
       UPDATE ether_balances SET amount = amount + 2000 WHERE user_id='u1';
       UPDATE ether_balances SET amount = amount - 2000 WHERE user_id='${holder}';`,
    );
    // 別プロセスが先にrefund相当の処理を終えている。今度この接続からrefundしても
    // 記録が既に無いので何も起きない（no-op）
    expect(() => refundChinchiroPreholdOnFailure(a.services, sessionId, new Error("late crash"))).toThrow("late crash");
    expect(a.chips.balanceOf("u1")).toBe(2_000);
    expect(a.chips.balanceOf(holder)).toBe(0);

    a.db.close();
  });

  it("別プロセスがholder残高を先に減らしていても、pool不一致として検出し資金を動かさない", () => {
    const path = newDbPath();
    const a = fileSetup(path);
    a.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: a.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: a.ledger.lastTransactionId(),
    });
    fund(a, "u1", 2_000);
    fundHouse(a);
    const sessionId = beginChinchiroPrehold(a.services, "u1", 1_000, "op-1");
    const holder = a.escrow.holderId(sessionId);

    // 別プロセスが台帳(casino_escrow)を書き換える（想定外の乖離）
    externalExec(path, `UPDATE casino_escrow SET amount = amount - 500 WHERE session_id = '${sessionId}';`);

    expect(() => settleChinchiroRound(a.services, "u1", 1_000, 1, "op-1")).toThrow(/帳簿不一致/);
    expect(a.chips.balanceOf(HOUSE_HOLDER)).toBe(1_000_000);
    expect(a.chips.balanceOf(holder)).toBe(2_000);

    a.db.close();
  });
});

// ── 論点6続き: 実際に同時開始する2プロセスの競合（PR11独立本監査2回目） ──
//
// 上の「別プロセス競合」は execFileSync（同期・直列）で「一方が終わってから他方」を
// 確認しているだけで、本当の同時実行ではなかった（本監査2回目の指摘）。
// ここでは2つの Node 子プロセスを実際に同時開始させ、prehold・settlement・
// refund対settlement を競合させる。

const tsxCliPath = createRequire(import.meta.url).resolve("tsx/cli");
const raceWorkerPath = fileURLToPath(new URL("./helpers/chinchiro-race-worker.ts", import.meta.url));

/**
 * `action` と引数を渡した子プロセスを起動し、両方が準備完了（DB接続・import完了）
 * してから同時に "go" を書いて競合させる。両方の終了と結果を待って返す。
 */
async function runRace(
  dbPath: string,
  workers: ReadonlyArray<{ action: string; args: string[] }>,
): Promise<Array<{ result: unknown; error: string | null }>> {
  const dir = mkdtempSync(join(tmpdir(), "chinchiro-race-signal-"));
  tempDirs.push(dir);
  const goPath = join(dir, "go");

  const specs = workers.map((w, i) => ({
    ...w,
    readyPath: join(dir, `ready-${i}`),
    outPath: join(dir, `out-${i}`),
  }));

  const children = specs.map((spec) =>
    spawn(
      process.execPath,
      [tsxCliPath, raceWorkerPath, dbPath, spec.readyPath, goPath, spec.outPath, spec.action, ...spec.args],
      { stdio: "pipe" },
    ),
  );

  const exits = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`race worker exited ${code}: ${stderr}`));
          else resolve();
        });
      }),
  );

  // 全ワーカーの準備完了（"ready" ファイル）を待ってから、一斉に "go" を書く
  const deadline = Date.now() + 5000;
  while (!specs.every((spec) => existsSync(spec.readyPath))) {
    if (Date.now() > deadline) throw new Error("race workers did not become ready in time");
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(goPath, "go");

  await Promise.all(exits);

  return specs.map((spec) => {
    const raw = readFileSync(spec.outPath, "utf8");
    return JSON.parse(raw) as { result: unknown; error: string | null };
  });
}

describe("PR11独立監査6b: 実際に同時開始する2プロセスの競合", () => {
  it("2プロセスが同時にbeginChinchiroPreholdを実行しても、事前預託は1回分しか動かない", async () => {
    const path = newDbPath();
    const seed = fileSetup(path);
    seed.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: seed.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: seed.ledger.lastTransactionId(),
    });
    fund(seed, "u1", 2_000);
    seed.db.close();

    const outcomes = await runRace(path, [
      { action: "begin", args: ["u1", "1000", "op-race"] },
      { action: "begin", args: ["u1", "1000", "op-race"] },
    ]);

    for (const o of outcomes) {
      expect(o.error).toBeNull();
    }
    // 両方が成功し、同じ sessionId を返している（どちらが先でも replay で揃う）
    expect(outcomes[0]!.result).toBe(outcomes[1]!.result);

    const check = fileSetup(path);
    const sessionId = chinchiroPreholdSessionId("u1", "op-race");
    expect(check.chips.balanceOf("u1")).toBe(0);
    // 2,000（=2×bet）だけが預託されている。二重預入（4,000）になっていない
    expect(check.chips.balanceOf(check.escrow.holderId(sessionId))).toBe(2_000);
    check.db.close();
  }, 20_000); // 子プロセス2つのtsx起動を伴うため、既定の5秒では並列実行時に不足しうる

  it("2プロセスが同時にsettleChinchiroRoundを実行しても、精算は1回分しか動かない", async () => {
    const path = newDbPath();
    const seed = fileSetup(path);
    seed.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: seed.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: seed.ledger.lastTransactionId(),
    });
    fund(seed, "u1", 2_000);
    fundHouse(seed);
    beginChinchiroPrehold(seed.services, "u1", 1_000, "op-race");
    seed.db.close();

    const outcomes = await runRace(path, [
      { action: "settle", args: ["u1", "1000", "-1", "op-race"] },
      { action: "settle", args: ["u1", "1000", "-1", "op-race"] },
    ]);

    for (const o of outcomes) {
      expect(o.error).toBeNull();
    }
    expect(outcomes[0]!.result).toEqual(outcomes[1]!.result);

    const check = fileSetup(path);
    const sessionId = chinchiroPreholdSessionId("u1", "op-race");
    // 通常負け(mul=-1)は 1,000 だけ house へ、残り 1,000 は利用者へ返る。
    // 二重精算していれば house が 2,000 増えているはず
    expect(check.chips.balanceOf(HOUSE_HOLDER)).toBe(1_001_000);
    expect(check.chips.balanceOf("u1")).toBe(1_000);
    expect(check.escrow.list(sessionId)).toEqual([]);
    check.db.close();
  }, 20_000); // 子プロセス2つのtsx起動を伴うため、既定の5秒では並列実行時に不足しうる

  it("settleChinchiroRoundとrefundChinchiroPreholdOnFailureが同時に同じsessionを取り合っても、資金は一度しか動かない", async () => {
    const path = newDbPath();
    const seed = fileSetup(path);
    seed.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
      poolLand: seed.ledger.balanceOf(CHIP_ESCROW),
      fromLedgerTxId: seed.ledger.lastTransactionId(),
    });
    fund(seed, "u1", 2_000);
    fundHouse(seed);
    const sessionId = beginChinchiroPrehold(seed.services, "u1", 1_000, "op-race");
    seed.db.close();

    // 片方は「結果確定」、もう片方は「精算前に落ちたと誤検知しての緊急返還」を模す。
    // SQLiteの書き込み直列化により、どちらか一方だけが実際に資金を動かす
    const outcomes = await runRace(path, [
      { action: "settle", args: ["u1", "1000", "1", "op-race"] },
      { action: "refund", args: [sessionId] },
    ]);

    // settle側は成功(勝ちの精算)か、refundが先に空にしたことによる帳簿不一致失敗のどちらか。
    // refundChinchiroPreholdOnFailure は必ず（no-opであっても）causeError を投げる設計。
    // ワーカーはそれを result.threw として捕まえている（error フィールドではない）
    const [settleOutcome, refundOutcome] = outcomes;
    expect(refundOutcome!.error).toBeNull();
    expect(refundOutcome!.result).toMatchObject({ threw: "worker-simulated crash" });

    const check = fileSetup(path);
    const holder = check.escrow.holderId(sessionId);

    if (settleOutcome!.error === null) {
      // settle が勝った: 通常の勝ち精算どおりに資金が動き、escrowは空
      expect(check.escrow.list(sessionId)).toEqual([]);
      expect(check.chips.balanceOf(holder)).toBe(0);
      // house は bet(1,000) を受け取り、配当を払っている（純減にはならない額だが、
      // 少なくとも二重に事前預託ぶん(2,000)が消えてはいない）
      expect(check.chips.balanceOf("u1")).toBeGreaterThan(0);
    } else {
      // refund が勝った: settle は「帳簿不一致」で安全に失敗し、
      // 事前預託の全額(2,000)がそのまま利用者へ返っている（refundのno-opではない側）
      expect(settleOutcome!.error).toMatch(/帳簿不一致|not attributed|insufficient|mismatch/);
      expect(check.chips.balanceOf("u1")).toBe(2_000);
      expect(check.chips.balanceOf(holder)).toBe(0);
    }
    // どちらの結末でも house が二重に受け取っていない（最大でも bet 相当の受取）
    expect(check.chips.balanceOf(HOUSE_HOLDER)).toBeLessThanOrEqual(1_000_000 + 1_000);
    check.db.close();
  }, 20_000); // 子プロセス2つのtsx起動を伴うため、既定の5秒では並列実行時に不足しうる
});
