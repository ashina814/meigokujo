import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { LedgerError } from "../src/ledger/errors.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

registerDefaultTxTypes();

const A = "user:alice";
const B = "user:bob";
const ESCROW = "sys:escrow:auction";

function setup(opts: ConstructorParameters<typeof Ledger>[1] = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db, opts);
  ledger.ensureAccount(A, "user");
  ledger.ensureAccount(B, "user");
  ledger.ensureAccount(ESCROW, "system");
  return ledger;
}

function fund(ledger: Ledger, to: string, amount: number, key = `fund:${to}:${amount}:${Math.random()}`) {
  return ledger.transfer({
    from: TREASURY,
    to,
    amount,
    type: "initial",
    actor: "system:test",
    idempotencyKey: key,
    approvedBy: amount > 1_000_000 ? "system:test" : undefined,
  });
}

describe("台帳の不変条件", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = setup();
  });

  it("国庫からの発行で残高が増え、発行残高=国庫の符号反転になる", () => {
    fund(ledger, A, 30_000);
    expect(ledger.balanceOf(A)).toBe(30_000);
    expect(ledger.balanceOf(TREASURY)).toBe(-30_000);
    expect(ledger.moneySupply()).toBe(30_000);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("残高不足は所持額と必要額つきで失敗する", () => {
    fund(ledger, A, 1_000);
    try {
      ledger.transfer({
        from: A,
        to: B,
        amount: 5_000,
        type: "transfer",
        actor: A,
        idempotencyKey: "t1",
      });
      expect.unreachable();
    } catch (e) {
      const err = e as LedgerError;
      expect(err.code).toBe("ERR_INSUFFICIENT");
      expect(err.details).toMatchObject({ balance: 1_000, required: 5_000 });
    }
    expect(ledger.balanceOf(A)).toBe(1_000);
    expect(ledger.balanceOf(B)).toBe(0);
  });

  it("同じ冪等キーは2度実行されない（duplicate=true で既存取引が返る）", () => {
    fund(ledger, A, 10_000);
    const first = ledger.transfer({
      from: A, to: B, amount: 3_000, type: "transfer", actor: A, idempotencyKey: "pay-1",
    });
    const second = ledger.transfer({
      from: A, to: B, amount: 3_000, type: "transfer", actor: A, idempotencyKey: "pay-1",
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.tx.id).toBe(first.tx.id);
    expect(ledger.balanceOf(A)).toBe(7_000);
    expect(ledger.balanceOf(B)).toBe(3_000);
  });

  it("金額は正の整数のみ（0・負・小数・上限超を拒否）", () => {
    fund(ledger, A, 10_000);
    for (const amount of [0, -100, 1.5, Number.NaN, 200_000_000]) {
      expect(() =>
        ledger.transfer({ from: A, to: B, amount, type: "transfer", actor: A, idempotencyKey: `bad:${amount}` }),
      ).toThrowError(/ERR_INVALID_AMOUNT/);
    }
  });

  it("登録簿にないタイプは拒否する", () => {
    expect(() =>
      ledger.transfer({ from: A, to: B, amount: 100, type: "unknown_type", actor: A, idempotencyKey: "u1" }),
    ).toThrowError(/ERR_UNKNOWN_TYPE/);
  });

  it("タイプの方向制約: transfer は user→user のみ", () => {
    expect(() =>
      ledger.transfer({ from: TREASURY, to: A, amount: 100, type: "transfer", actor: "staff", idempotencyKey: "d1" }),
    ).toThrowError(/ERR_KIND_MISMATCH/);
  });

  it("自分自身への送金は不可", () => {
    fund(ledger, A, 1_000);
    expect(() =>
      ledger.transfer({ from: A, to: A, amount: 100, type: "transfer", actor: A, idempotencyKey: "s1" }),
    ).toThrowError(/ERR_SELF_TRANSFER/);
  });

  it("凍結口座は入出金とも拒否", () => {
    fund(ledger, A, 1_000);
    ledger.setAccountStatus(B, "frozen");
    expect(() =>
      ledger.transfer({ from: A, to: B, amount: 100, type: "transfer", actor: A, idempotencyKey: "f1" }),
    ).toThrowError(/ERR_FROZEN/);
  });

  it("エスクローは負残高になれない（負を許すのは国庫だけ）", () => {
    expect(() =>
      ledger.transfer({ from: ESCROW, to: A, amount: 100, type: "auction_refund", actor: "system", idempotencyKey: "e1" }),
    ).toThrowError(/ERR_INSUFFICIENT/);
  });
});

describe("高額承認・未成年ゲート", () => {
  it("閾値超は approvedBy が無いと ERR_NEEDS_APPROVAL", () => {
    const ledger = setup();
    fund(ledger, A, 2_000_000);
    expect(() =>
      ledger.transfer({ from: A, to: B, amount: 1_000_001, type: "transfer", actor: A, idempotencyKey: "big1" }),
    ).toThrowError(/ERR_NEEDS_APPROVAL/);
    const ok = ledger.transfer({
      from: A, to: B, amount: 1_000_001, type: "transfer", actor: A,
      idempotencyKey: "big2", approvedBy: "staff:zeus",
    });
    expect(ok.tx.approved_by).toBe("staff:zeus");
  });

  it("minorBlocked タイプは未成年を台帳レベルで弾く", () => {
    const minors = new Set([A]);
    const ledger = setup({ isMinor: (id) => minors.has(id) });
    fund(ledger, A, 10_000);
    expect(() =>
      ledger.transfer({ from: A, to: ESCROW, amount: 500, type: "bet", actor: A, idempotencyKey: "m1" }),
    ).toThrowError(/ERR_MINOR_BLOCKED/);
    // ゲート対象外のタイプ（transfer）は未成年でも通る
    const ok = ledger.transfer({ from: A, to: B, amount: 500, type: "transfer", actor: A, idempotencyKey: "m2" });
    expect(ok.duplicate).toBe(false);
  });
});

describe("巻き戻し", () => {
  it("逆取引が作られ、元取引は消えない", () => {
    const ledger = setup();
    fund(ledger, A, 10_000);
    const original = ledger.transfer({
      from: A, to: B, amount: 4_000, type: "transfer", actor: A, idempotencyKey: "r1",
    });
    const reversal = ledger.reverse(original.tx.id, "staff:bank", "誤送金の巻き戻し");
    expect(reversal.tx.reversal_of).toBe(original.tx.id);
    expect(ledger.balanceOf(A)).toBe(10_000);
    expect(ledger.balanceOf(B)).toBe(0);
    expect(ledger.getTx(original.tx.id)).toBeDefined();
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it("二重の巻き戻しと、巻き戻しの巻き戻しは不可", () => {
    const ledger = setup();
    fund(ledger, A, 10_000);
    const original = ledger.transfer({
      from: A, to: B, amount: 4_000, type: "transfer", actor: A, idempotencyKey: "r2",
    });
    const reversal = ledger.reverse(original.tx.id, "staff:bank", "巻き戻し");
    expect(() => ledger.reverse(original.tx.id, "staff:bank", "もう一度")).toThrowError(/ERR_ALREADY_REVERSED/);
    expect(() => ledger.reverse(reversal.tx.id, "staff:bank", "巻き戻しの巻き戻し")).toThrowError(
      /ERR_REVERSAL_OF_REVERSAL/,
    );
  });

  it("相手が使い切っていたら巻き戻しは失敗する", () => {
    const ledger = setup();
    fund(ledger, A, 5_000);
    const original = ledger.transfer({
      from: A, to: B, amount: 5_000, type: "transfer", actor: A, idempotencyKey: "r3",
    });
    // B が受け取った 5,000 を使い切る
    ledger.transfer({ from: B, to: ESCROW, amount: 5_000, type: "auction_bid", actor: B, idempotencyKey: "spend" });
    expect(() => ledger.reverse(original.tx.id, "staff:bank", "巻き戻し")).toThrowError(/ERR_INSUFFICIENT/);
  });
});

describe("検算と outbox", () => {
  it("balances を改竄すると検算が不一致を検出する", () => {
    const ledger = setup();
    const db = (ledger as unknown as { db: import("better-sqlite3").Database }).db;
    fund(ledger, A, 10_000);
    db.prepare("UPDATE balances SET amount = 999999 WHERE account_id = ?").run(A);
    const result = ledger.verifyIntegrity();
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.accountId === A)).toBe(true);
  });

  it("取引すると audit_log が、publicLog タイプなら public_log も outbox に積まれる", () => {
    const ledger = setup();
    fund(ledger, A, 10_000);
    ledger.transfer({ from: A, to: B, amount: 100, type: "transfer", actor: A, idempotencyKey: "o1" });
    const pending = ledger.pendingOutbox();
    const kinds = pending.map((p) => p.kind);
    expect(kinds.filter((k) => k === "audit_log").length).toBeGreaterThanOrEqual(2); // initial + transfer
    expect(kinds).toContain("public_log"); // transfer は公開ログ対象
    for (const p of pending) ledger.markOutboxDelivered(p.id);
    expect(ledger.pendingOutbox().length).toBe(0);
  });
});

describe("計器盤の経済指標", () => {
  it("flowBetween が発行量・回収量・純増を返す", () => {
    const ledger = setup();
    fund(ledger, A, 30_000); // 発行
    ledger.transfer({ from: A, to: TREASURY, amount: 5_000, type: "fine", actor: "staff", idempotencyKey: "f1" }); // 回収
    ledger.transfer({ from: A, to: B, amount: 1_000, type: "transfer", actor: A, idempotencyKey: "t1" }); // 循環（国庫を通らない）

    const flow = ledger.flowBetween(0, Math.floor(Date.now() / 1000) + 60);
    expect(flow.issued).toBe(30_000);
    expect(flow.collected).toBe(5_000);
    expect(flow.net).toBe(25_000);
  });

  it("escrowTotal は国庫以外のシステム勘定の残高合計", () => {
    const ledger = setup();
    fund(ledger, A, 10_000);
    ledger.transfer({ from: A, to: ESCROW, amount: 3_000, type: "auction_bid", actor: A, idempotencyKey: "e1" });
    expect(ledger.escrowTotal()).toBe(3_000); // 国庫の負残高は含まれない
  });
});
