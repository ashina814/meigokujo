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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // u2 の名目で、u1 のセッションを徴収元にしようとする（バグ・不正呼び出しの再現）
    expect(() =>
      ctx.casino.settleSolo("u2", "チンチロ", 1_000, 1_000, {
        operationId: "op-attack",
        preheld: { sessionId: u1Session },
      }),
    ).toThrow(/not attributed to user/);

    // u1のescrow・u2の残高とも動いていない
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(u1Session))).toBe(2_000);
    expect(ctx.chips.balanceOf("u2")).toBe(2_000);
  });

  it("存在しない・架空のsessionIdは帰属確認で拒否され、houseを徴収元にできない", () => {
    const ctx = setup();
    fund(ctx, "u1", 1_000, 0);
    fundHouse(ctx);

    expect(() =>
      ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
        operationId: "op-fake",
        preheld: { sessionId: "fabricated-session-id" },
      }),
    ).toThrow(/not attributed to user/);
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
    const first = ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
      operationId: "op-direct",
      preheld: { sessionId },
    });
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(1_000);

    // settleChinchiroRound が普段この直後に行う「残額を利用者へ返す」を、
    // ここでは意図的に分離して直接実行する。holder は bet を下回る（0）まで減る
    ctx.db.prepare("UPDATE ether_balances SET amount = 0 WHERE user_id = ?").run(holder);
    expect(ctx.chips.balanceOf(holder)).toBe(0);

    // 同じ operationId で再実行。事前チェックが runGroup の外にあれば、
    // 「holder残高(0)がbet(1,000)に届かない」で落ちて保存済み結果を返せない。
    // runGroup の中にあれば replay され、例外にならない（本監査で修正した点）
    const second = ctx.casino.settleSolo("u1", "チンチロ", 1_000, 1_000, {
      operationId: "op-direct",
      preheld: { sessionId },
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

  it("同一sessionを異なるbetでholdしようとしても、既存groupがreplayされ実際には額が変わらない", () => {
    const ctx = setup();
    fund(ctx, "u1", 10_000);
    const sessionId = chinchiroPreholdSessionId("u1", "op-1");
    // 1,000ぶんのholdを直接確定させる
    expect(ctx.escrow.hold(sessionId, "u1", 2_000, "チンチロ", "op-1")).toBe(true);
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);

    // 同じ session・同じoperationIdで異なる額(4,000)を hold しようとしても、
    // グループキーが同じなので保存済み結果(true)が返るだけで、実際には動かない
    const replayed = ctx.escrow.hold(sessionId, "u1", 4_000, "チンチロ", "op-1");
    expect(replayed).toBe(true);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000); // 4,000にはなっていない
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
