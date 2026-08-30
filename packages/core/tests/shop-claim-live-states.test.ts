import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_CLAIM_LIVE_STATES,
  EXTERNAL_CLAIM_LIVE_STATES_SQL,
  EventLog,
  Ledger,
  Shop,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

/**
 * 「生きている claim」の集合を、**Core と DB の索引で1つの意味に保つ**。
 *
 * 1 purchase につき生きた claim は1件、という境界はDBの部分ユニーク索引が守っている。
 * Core が「生きている」と見なす集合と索引が縛る集合がズレると、
 * Core は止めているつもりなのにDBは重複を許す（またはその逆）という穴が開く。
 * Service 内の重複を1つにしただけでは SSOT は完成していない。
 */

registerDefaultTxTypes();
const USER = "u-claim";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:claim",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-vip" }),
    } as never,
    "staff",
  );
  return { db, shop, item };
}

/** 索引のDDLから、実際に制限されている状態名を取り出す */
function indexStates(db: ReturnType<typeof openDb>): string[] {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_shop_external_delivery_open'")
    .pluck()
    .get() as string | undefined;
  if (sql === undefined) throw new Error("uq_shop_external_delivery_open が存在しない");
  const where = sql.slice(sql.toUpperCase().lastIndexOf("WHERE"));
  return [...where.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe("生きている claim の集合は、Core と DB の索引で一致する", () => {
  it("fresh DB の索引が縛る集合が、Core の定義と同じ", () => {
    const ctx = setup();
    expect(indexStates(ctx.db)).toEqual([...EXTERNAL_CLAIM_LIVE_STATES].sort());
    ctx.db.close();
  });

  it("Core が live とみなす各状態で、2件目の claim をDBが拒む", () => {
    for (const state of EXTERNAL_CLAIM_LIVE_STATES) {
      const ctx = setup();
      const purchaseId = ctx.shop.purchase({
        itemId: ctx.item.id,
        userId: USER,
        actor: `user:${USER}`,
        memberRoleIds: [],
        expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
      }).purchase.id;

      const insert = (token: string, st: string) =>
        ctx.db
          .prepare(
            `INSERT INTO shop_external_delivery_attempts
             (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at)
             VALUES (?,?,?,?,1,1)`,
          )
          .run(purchaseId, token, "add_role", st);

      insert("t1", state);
      // Core も「生きている」と見なしている
      expect(ctx.shop.externalDeliveryInFlight(purchaseId)).toBe(true);
      // DB も2件目を許さない
      expect(() => insert("t2", state)).toThrow(/UNIQUE constraint failed/);
      ctx.db.close();
    }
  });

  it("live でない状態は、いくつ並んでも構わない", () => {
    const ctx = setup();
    const purchaseId = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase.id;
    const insert = (token: string, st: string) =>
      ctx.db
        .prepare(
          `INSERT INTO shop_external_delivery_attempts
           (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at)
           VALUES (?,?,?,?,1,1)`,
        )
        .run(purchaseId, token, "add_role", st);

    for (const state of ["settled", "released"]) {
      expect(EXTERNAL_CLAIM_LIVE_STATES).not.toContain(state);
      insert(`${state}-1`, state);
      insert(`${state}-2`, state);
    }
    expect(ctx.shop.externalDeliveryInFlight(purchaseId)).toBe(false);
    ctx.db.close();
  });

  /**
   * **集合を変えたら migration が要る**、という docs の主張そのものを固定する。
   *
   * `CREATE UNIQUE INDEX IF NOT EXISTS` は、既に同じ名前の索引があれば**何もしない**。
   * 定義が違っていても作り直さない。つまり定数を書き換えてデプロイしただけでは、
   * 既存DBの索引は古い集合を守り続ける。
   *
   * 上の fresh DB alignment テストとは別の契約。あちらは「新しく作れば一致する」、
   * こちらは「既にあるものは黙って直らない」。
   */
  it("既存DBの索引は、定義を変えて開き直しても作り直されない", () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-claim-index-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "bot.db");

    // 1) 通常どおり作り、claim を付ける相手も用意しておく
    const first = openDb(dbPath);
    expect(indexStates(first)).toEqual([...EXTERNAL_CLAIM_LIVE_STATES].sort());
    const ledger = new Ledger(first);
    const shop = new Shop(first, ledger, new EventLog(first));
    ledger.ensureAccount(`user:${USER}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${USER}`,
      amount: 1_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:claim-file",
    });
    const item = shop.createItem(
      {
        name: "裏口",
        price_land: 100,
        kind: "monthly",
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: "r-vip" }),
      } as never,
      "staff",
    );
    const purchaseId = shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase.id;

    // 2) 旧定義（live は in_flight だけ）へ意図的に差し替える
    first.exec("DROP INDEX uq_shop_external_delivery_open");
    first.exec(
      `CREATE UNIQUE INDEX uq_shop_external_delivery_open
         ON shop_external_delivery_attempts(purchase_id)
        WHERE state IN ('in_flight')`,
    );
    expect(indexStates(first)).toEqual(["in_flight"]);
    first.close();

    // 3) 通常の openDb で開き直す
    const reopened = openDb(dbPath);

    // 4) IF NOT EXISTS なので、古い定義がそのまま残る
    expect(indexStates(reopened)).toEqual(["in_flight"]);
    expect(indexStates(reopened)).not.toEqual([...EXTERNAL_CLAIM_LIVE_STATES].sort());

    // 5) 結果として、Core が live とみなす uncertain をDBは1件に縛らない
    const insert = (token: string) =>
      reopened
        .prepare(
          `INSERT INTO shop_external_delivery_attempts
           (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at)
           VALUES (?,?,?,'uncertain',1,1)`,
        )
        .run(purchaseId, token, "add_role");
    insert("u1");
    // **古い索引では防げない。** これが migration を書かないと起きること
    expect(() => insert("u2")).not.toThrow();
    expect(
      reopened
        .prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE purchase_id=? AND state='uncertain'")
        .pluck()
        .get(purchaseId),
    ).toBe(2);
    // 索引を新しい定義へ作り直せば、また1件に縛られる（＝これが migration の中身）。
    // claim の記録は追記専用なので、先に重複を live でない状態へ動かす必要がある——
    // これも migration が引き受ける仕事で、索引を張り直すだけでは済まない。
    reopened.exec("UPDATE shop_external_delivery_attempts SET state='released' WHERE attempt_token='u2'");
    reopened.exec("DROP INDEX uq_shop_external_delivery_open");
    reopened.exec(
      `CREATE UNIQUE INDEX uq_shop_external_delivery_open
         ON shop_external_delivery_attempts(purchase_id)
        WHERE state IN ${EXTERNAL_CLAIM_LIVE_STATES_SQL}`,
    );
    expect(indexStates(reopened)).toEqual([...EXTERNAL_CLAIM_LIVE_STATES].sort());
    expect(() => insert("u3")).toThrow(/UNIQUE constraint failed/);
    reopened.close();
  });
});
