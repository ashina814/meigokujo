import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * `safetySnapshot()` は、**実際に存在した瞬間**しか説明しない。
 *
 * 9本のSELECTを素直に順番へ並べると、最初の purchase を読んだあとに別接続が
 * commit した場合、「古い purchase 行 ＋ 新しい claim / 返金 / 決着」という
 * 一度も存在しなかった state vector を返せてしまう。資産を動かさなくても、
 * 運営と監査へ嘘の事実を渡すことになる。
 *
 * ここでは **purchase を読み終えた直後**に別接続の決着を commit させ、
 * 返ってきた snapshot が commit 前か commit 後の**どちらか一方**であることを見る。
 */

registerDefaultTxTypes();
const USER = "u-snap";
const PRICE = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * 最初の `shop_purchases` の読みが終わった直後に1度だけ `onFirstPurchaseRead` を呼ぶ。
 * 「purchase は読んだが、claim も返金もまだ読んでいない」という一点を狙う。
 */
function hookAfterFirstPurchaseRead(db: Database, onFirstPurchaseRead: () => void): Database {
  let armed = true;
  let inside = false;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const sql = String(args[0] ?? "");
        const isPurchaseRead = /FROM\s+shop_purchases/i.test(sql);
        const stmt = (value as (...a: unknown[]) => unknown).apply(target, args) as Record<string, unknown>;
        return new Proxy(stmt, {
          get(st, key) {
            const member = Reflect.get(st, key, st);
            if (typeof member !== "function") return member;
            const fn = (member as (...x: unknown[]) => unknown).bind(st);
            if (key !== "get" || !isPurchaseRead) return fn;
            return (...a: unknown[]) => {
              const out = fn(...a);
              if (armed && !inside) {
                armed = false;
                inside = true;
                try {
                  onFirstPurchaseRead();
                } finally {
                  inside = false;
                }
              }
              return out;
            };
          },
        });
      };
    },
  });
  return proxy as unknown as Database;
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-snapshot-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");

  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
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
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:snapshot",
  });
  const purchaseId = shop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
  }).purchase.id;
  const claimToken = (
    shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" }) as { token: string }
  ).token;
  db.close();

  return { dbPath, purchaseId, claimToken };
}

describe("snapshot は commit 前か後のどちらか一方だけを見る", () => {
  it("purchase を読んだ直後に別接続が決着しても、混ざった状態を返さない", () => {
    const { dbPath, purchaseId, claimToken } = seed();

    // B: 割り込んで決着させる側
    const writerDb = openDb(dbPath);
    const writer = new Shop(writerDb, new Ledger(writerDb), new EventLog(writerDb));

    // A: snapshot を読む側。purchase を読み終えた瞬間に B を走らせる
    const readerDb = openDb(dbPath);
    let settled = false;
    const hooked = hookAfterFirstPurchaseRead(readerDb, () => {
      writer.settleVerifiedFailure({ purchaseId, claimToken, reason: "delivery_failed", actor: "system" });
      settled = true;
    });
    const reader = new Shop(hooked, new Ledger(hooked), new EventLog(hooked));

    const snapshot = reader.safetySnapshot(purchaseId)!;

    expect(settled).toBe(true); // 本当に割り込んでいる
    readerDb.close();

    const before =
      snapshot.contract.status === "active" &&
      snapshot.externalClaim !== null &&
      snapshot.externalClaim.token === claimToken &&
      !snapshot.fulfillment.evidence;
    const after =
      snapshot.contract.status === "refunded" && snapshot.externalClaim === null && !snapshot.refund.settlementPending;

    // **どちらか一方。** 混ざった state vector は返さない
    expect([before, after]).toContain(true);
    expect(before && after).toBe(false);
    // 具体的に禁止したい組み合わせ: **active なのに守りが1つも無い**。
    //
    // 守りの authority は `recoveryOpen`（商館が返金をやり直せるか）ではなく
    // `settlementPending`（金銭の決着が終わっていないか）。前者で見ると、
    // 代替支払の引き継ぎ——`recoveryOpen=false` / `settlementPending=true` /
    // `operationsHandoff=true`——という**正常な状態を異常として扱ってしまう**。
    expect(
      snapshot.contract.status === "active" && snapshot.externalClaim === null && !snapshot.refund.settlementPending,
    ).toBe(false);
    // commit 前後どちらでも、4概念が矛盾しない組み合わせになっている
    expect(snapshot.refund.recoveryOpen && snapshot.refund.operationsHandoff).toBe(false);
    expect((snapshot.refund.recoveryOpen || snapshot.refund.operationsHandoff) && !snapshot.refund.settlementPending).toBe(
      false,
    );
    expect(snapshot.contradictions).toEqual([]);

    // 決着そのものは通っている（読み側が書き込みを止めていない）
    expect(writer.getPurchase(purchaseId)!.status).toBe("refunded");
    writerDb.close();
  });

  it("読み取りのために書き込みロックを取らない", () => {
    const { dbPath, purchaseId } = seed();
    const readerDb = openDb(dbPath);
    const reader = new Shop(readerDb, new Ledger(readerDb), new EventLog(readerDb));

    const writerDb = openDb(dbPath);
    // 待たされるなら、そこで SQLITE_BUSY になって分かる
    writerDb.pragma("busy_timeout = 0");
    const writer = new Shop(writerDb, new Ledger(writerDb), new EventLog(writerDb));

    const hooked = hookAfterFirstPurchaseRead(readerDb, () => {
      // snapshot の途中でも、別接続は普通に書ける
      writer.recordRefundFailure({ purchaseId, amount: PRICE, reason: "delivery_failed", actor: "system" });
    });
    const hookedShop = new Shop(hooked, new Ledger(hooked), new EventLog(hooked));

    expect(() => hookedShop.safetySnapshot(purchaseId)).not.toThrow();
    expect(reader.safetySnapshot(purchaseId)!.refund.settlementIssueHistory).toBe(1);
    readerDb.close();
    writerDb.close();
  });

  it("既に transaction の中なら、その snapshot をそのまま使う", () => {
    const { dbPath, purchaseId, claimToken } = seed();
    const db = openDb(dbPath);
    const shop = new Shop(db, new Ledger(db), new EventLog(db));

    const inside = db.transaction(() => {
      const first = shop.safetySnapshot(purchaseId)!;
      const second = shop.safetySnapshot(purchaseId)!;
      return [first, second];
    })();

    expect(inside[0]).toEqual(inside[1]);
    expect(inside[0]!.externalClaim?.token).toBe(claimToken);
    db.close();
  });
});
