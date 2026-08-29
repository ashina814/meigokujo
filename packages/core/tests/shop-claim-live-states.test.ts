import { describe, expect, it } from "vitest";
import { EXTERNAL_CLAIM_LIVE_STATES, EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

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

  it("索引は再オープンしても作り直されない（DBに焼き付く）", () => {
    // 集合を変えるときに migration が要る、という docs の記述の裏付け
    const ctx = setup();
    const first = indexStates(ctx.db);
    ctx.db.close();
    // 同じ定義から作られる限り、再オープンで意味は変わらない
    const again = setup();
    expect(indexStates(again.db)).toEqual(first);
    again.db.close();
  });
});
