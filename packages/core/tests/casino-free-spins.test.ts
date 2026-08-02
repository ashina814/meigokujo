import { describe, expect, it } from "vitest";
import { FreeSpins, openDb } from "../src/index.js";

/**
 * PR3（レビュー指摘）: 獲得済みフリースピンの保留台帳。
 *
 * ここで見るのは「権利がプロセスの寿命と切り離されているか」だけ。
 * 実際の払い出し（お守り・胴元余力・JP）は apps/bot 側のテストで見る。
 */

function setup() {
  const db = openDb(":memory:");
  return { db, freeSpins: new FreeSpins(db) };
}

const grantInput = (over: Partial<Parameters<FreeSpins["grant"]>[0]> = {}) => ({
  userId: "u1",
  operationId: "int-1",
  spinNo: 1,
  bet: 1_000,
  sourceGroup: "slots:spin:u1:int-1:paid",
  reels: ["王冠", "王冠", "王冠"] as [string, string, string],
  rawPayout: 25_000,
  amuletEffect: { kind: "none" as const, amount: 0 },
  payout: 25_000,
  jackpotWon: false,
  jackpotClaim: 0,
  totalClaim: 25_000,
  ...over,
});

describe("保留記録は必要な項目を全部持つ", () => {
  it("利用者・操作ID・賭け額・獲得元グループ・出目・時刻が残る", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());
    expect(row.userId).toBe("u1");
    expect(row.operationId).toBe("int-1");
    expect(row.spinNo).toBe(1);
    expect(row.bet).toBe(1_000);
    expect(row.sourceGroup).toBe("slots:spin:u1:int-1:paid");
    expect(row.reels).toEqual(["王冠", "王冠", "王冠"]);
    expect(row.rawPayout).toBe(25_000);
    expect(row.amuletEffect).toEqual({ kind: "none", amount: 0 });
    expect(row.payout).toBe(25_000);
    expect(row.totalClaim).toBe(25_000);
    expect(row.status).toBe("pending");
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.settledAt).toBeNull();
    c.db.close();
  });

  it("払い出しの業務グループ鍵は行の identity だけで決まる（再起動しても同じ）", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());
    expect(c.freeSpins.payoutGroupKey(row)).toBe("slots:spin:u1:int-1:free:1");
    // 別インスタンスから読み直しても同じ鍵
    const reopened = new FreeSpins(c.db);
    expect(reopened.payoutGroupKey(reopened.get(row.id)!)).toBe("slots:spin:u1:int-1:free:1");
    c.db.close();
  });
});

describe("冪等性", () => {
  it("同じ (利用者・操作・回数) を二度 grant しても1件だけ", () => {
    const c = setup();
    const a = c.freeSpins.grant(grantInput());
    const b = c.freeSpins.grant(grantInput({ reels: ["😈", "😈", "😈"] as [string, string, string] }));
    expect(b.id).toBe(a.id);
    // 後から出目を書き換えられない（最初に確定した結果が残る）
    expect(b.reels).toEqual(["王冠", "王冠", "王冠"]);
    expect(c.freeSpins.pendingCount()).toBe(1);
    c.db.close();
  });

  it("settled にできるのは一度だけ", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());
    expect(c.freeSpins.markSettled(row.id)).toBe(true);
    expect(c.freeSpins.markSettled(row.id)).toBe(false);
    expect(c.freeSpins.get(row.id)!.status).toBe("settled");
    expect(c.freeSpins.get(row.id)!.settledAt).toBeGreaterThan(0);
    c.db.close();
  });

  it("settled になった行は processing へ戻せない（二度払いの入口を塞ぐ）", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());
    c.freeSpins.markSettled(row.id);
    expect(c.freeSpins.beginProcessing(row.id)).toBe(false);
    expect(c.freeSpins.get(row.id)!.status).toBe("settled");
    c.db.close();
  });
});

describe("保留一覧", () => {
  it("settled は出さず、利用者で絞れる", () => {
    const c = setup();
    const a = c.freeSpins.grant(grantInput({ userId: "a", operationId: "i1" }));
    c.freeSpins.grant(grantInput({ userId: "b", operationId: "i2" }));
    expect(c.freeSpins.listPending()).toHaveLength(2);
    expect(c.freeSpins.listPending("a")).toHaveLength(1);

    c.freeSpins.markSettled(a.id);
    expect(c.freeSpins.listPending()).toHaveLength(1);
    expect(c.freeSpins.listPending("a")).toEqual([]);
    expect(c.freeSpins.pendingCount()).toBe(1);
    c.db.close();
  });

  it("processing のまま残った行も保留として拾う（落ちた処理を取りこぼさない）", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());
    c.freeSpins.beginProcessing(row.id);
    expect(c.freeSpins.get(row.id)!.status).toBe("processing");
    expect(c.freeSpins.listPending().map((r) => r.id)).toEqual([row.id]);
    c.db.close();
  });
});

describe("再起動をまたぐ", () => {
  it("同じ DB を別インスタンスで開いても保留が残る", () => {
    const c = setup();
    const row = c.freeSpins.grant(grantInput());

    // プロセスが落ちて、同じ DB からサービスを組み直した想定
    const restarted = new FreeSpins(c.db);
    const found = restarted.listPending("u1");
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(row.id);
    expect(found[0]!.reels).toEqual(row.reels);
    c.db.close();
  });
});
