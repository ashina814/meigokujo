import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 失効の巡回を、**決着処理のあらゆる文の切れ目**で割り込ませる。
 *
 * 2プロセスをぶつけるだけだと「たまたま当たらなかった」が通ってしまう。危ないのは
 * claim を解放した直後・返金の transaction を取る前という極めて短い隙なので、
 * ここでは別接続の失効を1文ごとに叩き込み、**隙が存在しないこと**を確かめる。
 *
 * 別接続から見えるのは commit 済みの状態だけなので、決着が1つの transaction に
 * 閉じている限り、危険な中間状態はそもそも観測できない。
 */

const USER = "interleave-refund";
const PRICE = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 文が1つ走るたびに `onStatement` を呼ぶ、薄い被せもの */
function withStatementHook(db: Database, onStatement: () => void): Database {
  let inside = false;
  const fire = () => {
    if (inside) return;
    inside = true;
    try {
      onStatement();
    } finally {
      inside = false;
    }
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const stmt = (value as (...a: unknown[]) => unknown).apply(target, args) as Record<string, unknown>;
        return new Proxy(stmt, {
          get(s, p) {
            const v = Reflect.get(s, p, s);
            if (typeof v !== "function") return v;
            const fn = (v as (...x: unknown[]) => unknown).bind(s);
            if (p !== "run") return fn;
            return (...a: unknown[]) => {
              const out = fn(...a);
              fire();
              return out;
            };
          },
        });
      };
    },
  });
  return proxy as unknown as Database;
}

function seed(breakLedger: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-interleave-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");

  const raw = openDb(dbPath);
  const setupLedger = new Ledger(raw);
  const setupShop = new Shop(raw, setupLedger, new EventLog(raw));
  const item = setupShop.createItem(
    {
      name: "裏口",
      price_land: PRICE,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-vip" }),
    } as never,
    "staff",
  );
  setupLedger.ensureAccount(`user:${USER}`, "user");
  setupLedger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:interleave",
  });
  const purchaseId = setupShop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: setupShop.quoteGenericPurchase(item.id).termsToken,
  }).purchase.id;
  const claim = setupShop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" });
  const claimToken = (claim as { token: string }).token;
  // 期限は既に過ぎている＝巡回が来れば失効させたがる。
  // 月額のままだと、接続を開くたびに走る期限延長のmigrationが expires_at を先へ書き戻し、
  // 「実は期限切れではない購入」を相手にした無意味なテストになってしまう。
  raw.prepare("UPDATE shop_items SET kind='one_shot' WHERE id=?").run(item.id);
  raw.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
  const balanceBefore = setupLedger.balanceOf(`user:${USER}`);

  // 割り込む側：別接続の失効
  const cronDb = openDb(dbPath);
  // 待たせない。**守っているのは書き込みロックではなく `expireIfDue()` の判断**、
  // というのがここで確かめたいこと。ロック待ちに助けられて通ったのでは意味がない。
  cronDb.pragma("busy_timeout = 0");
  const cronShop = new Shop(cronDb, new Ledger(cronDb), new EventLog(cronDb));
  let attempts = 0;
  const attemptExpiry = () => {
    attempts += 1;
    try {
      cronShop.expireIfDue(purchaseId, "system:cron");
    } catch {
      // 巡回が失敗しても、決着側の契約は変わらない
    }
  };

  // 決着する側：1文ごとに巡回が割り込む接続
  const workDb = openDb(dbPath);
  const workLedger = new Ledger(workDb);
  if (breakLedger) {
    (workLedger as unknown as { transfer: unknown }).transfer = () => {
      throw new Error("ledger unavailable");
    };
  }
  const hooked = withStatementHook(workDb, attemptExpiry);
  const workShop = new Shop(hooked, workLedger, new EventLog(hooked));

  // 全部の接続を開き終えた時点で、本当に期限切れであることを確かめる
  const overdue = raw.prepare("SELECT expires_at FROM shop_purchases WHERE id=?").pluck().get(purchaseId) as number;
  if (overdue > Math.floor(Date.now() / 1000)) throw new Error(`test setup: purchase is not overdue (${overdue})`);

  return {
    dbPath,
    purchaseId,
    claimToken,
    balanceBefore,
    workShop,
    attemptCount: () => attempts,
    close: () => {
      raw.close();
      cronDb.close();
      workDb.close();
    },
  };
}

/** すべての接続を閉じたうえで、最終状態を見に行く（再起動相当） */
function finalState(dbPath: string, purchaseId: number) {
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const out = {
    status: shop.getPurchase(purchaseId)!.status,
    balance: ledger.balanceOf(`user:${USER}`),
    obligations: db
      .prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?")
      .pluck()
      .get(purchaseId) as number,
    inQueue: shop.countRefundFailures(),
    retryOpen: shop.quoteRefundRetry(purchaseId).open,
    refundEvents: new EventLog(db).listByType("shop_refunded").length,
  };
  db.close();
  return out;
}

describe("決着の途中に失効が割り込む（1文ごと）", () => {
  it("返金できるとき: 割り込まれても失効せず、ちょうど1回返る", () => {
    const ctx = seed(false);
    ctx.workShop.settleVerifiedFailure({
      purchaseId: ctx.purchaseId,
      claimToken: ctx.claimToken,
      reason: "delivery_failed",
      actor: "system",
    });
    expect(ctx.attemptCount()).toBeGreaterThan(0); // 本当に割り込んでいる
    ctx.close();

    const after = finalState(ctx.dbPath, ctx.purchaseId);
    expect(after.status).toBe("refunded");
    expect(after.balance).toBe(ctx.balanceBefore + PRICE);
    expect(after.refundEvents).toBe(1);
    expect(after.inQueue).toBe(0);
  });

  it("返金できないとき: 割り込まれても失効せず、義務が durable に残る", () => {
    const ctx = seed(true);
    ctx.workShop.settleVerifiedFailure({
      purchaseId: ctx.purchaseId,
      claimToken: ctx.claimToken,
      reason: "delivery_failed",
      actor: "system",
    });
    expect(ctx.attemptCount()).toBeGreaterThan(0);
    ctx.close();

    const after = finalState(ctx.dbPath, ctx.purchaseId);
    // **禁止: 未返金なのに失効している**
    expect(after.status).not.toBe("expired");
    expect(after.status).toBe("active");
    expect(after.balance).toBe(ctx.balanceBefore);
    expect(after.obligations).toBeGreaterThan(0);
    expect(after.inQueue).toBe(1);
    expect(after.retryOpen).toBe(true);
    expect(after.refundEvents).toBe(0);
  });

  it("別接続から見える状態は「claimで守られている」か「決着済み」だけ", () => {
    const ctx = seed(true);
    const db = openDb(ctx.dbPath);
    const shop = new Shop(db, new Ledger(db), new EventLog(db));
    const seen: string[] = [];
    const probe = () => {
      const purchase = shop.getPurchase(ctx.purchaseId)!;
      const guarded =
        (db
          .prepare(
            "SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE purchase_id=? AND state IN ('in_flight','uncertain')",
          )
          .pluck()
          .get(ctx.purchaseId) as number) > 0;
      const owed =
        (db
          .prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?")
          .pluck()
          .get(ctx.purchaseId) as number) > 0;
      seen.push(`${purchase.status}/${guarded ? "guarded" : "open"}/${owed ? "owed" : "none"}`);
    };

    probe();
    ctx.workShop.settleVerifiedFailure({
      purchaseId: ctx.purchaseId,
      claimToken: ctx.claimToken,
      reason: "delivery_failed",
      actor: "system",
    });
    probe();
    db.close();
    ctx.close();

    // 未返金で無防備な瞬間（守りが外れて義務も無い active）は一度も現れない
    expect(seen).not.toContain("active/open/none");
    expect(seen[0]).toBe("active/guarded/none");
    expect(seen.at(-1)).toBe("active/open/owed");
  });
});
