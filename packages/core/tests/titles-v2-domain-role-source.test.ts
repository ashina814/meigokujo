import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Departments } from "../src/departments/service.js";
import { Ledger } from "../src/ledger/service.js";
import { Settings } from "../src/settings/service.js";
import {
  intersectTrustedRoleFamilyIntervals,
} from "../src/role-family/domain-temporal.js";
import {
  CANONICAL_DEPARTMENT_DOMAIN_TAGS,
  RoleFamilyTemporal,
  buildPublicDepartmentRoleFamilyManifest,
  type RoleFamilyManifest,
} from "../src/role-family/temporal.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { computeShopRolePurchaseSafe } from "../src/titles/v2-domain-role.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const DAY = 86_400;
const BASE = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000);
const SHOP_ROLE = "role-shop-staff";
const SHOP_MANIFEST: RoleFamilyManifest = {
  provenance: "explicit_manifest",
  families: [{ familyKey: "department:冥界商館", roleIds: [SHOP_ROLE], tags: ["public_department", "shop"] }],
};
const NON_DOMAIN_MANIFEST: RoleFamilyManifest = {
  provenance: "explicit_manifest",
  families: [{ familyKey: "department:冥界商館", roleIds: [SHOP_ROLE], tags: ["public_department"] }],
};

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.shop-role-purchase-safe",
    name: "test",
    description: "test",
    sources: ["shop_role_purchase_safe"] as const,
    triggers: ["economy_activity"],
    lifecycle: "active",
    catalog: "test",
    emoji: "x",
    hidden: false,
    publicAnnounce: false,
    themeKey: "test-theme",
    groupKey: "test-group",
    collectionDomainKey: "test-domain",
    scope: { type: "global" as const },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function setup() {
  const db = openDb(":memory:");
  let clock = BASE - DAY;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test" });
  clock = BASE + 100 * DAY;
  db.prepare(
    `INSERT INTO shop_items
       (id,name,price_land,kind,delivery,enabled,created_at,updated_at)
     VALUES (1,'eligible',1,'one_shot','manual',1,?,?)`,
  ).run(BASE, BASE);
  return { db, store, temporal: new RoleFamilyTemporal(db), nextPurchaseId: 1 };
}

function purchase(
  ctx: ReturnType<typeof setup>,
  userId: string,
  purchasedAt: number,
  options: { eligible?: boolean; origin?: "storefront" | "reevaluation"; productKey?: string } = {},
): number {
  const id = ctx.nextPurchaseId++;
  ctx.db.prepare(
    `INSERT INTO shop_purchases
       (id,item_id,user_id,purchased_at,paid_land,status,auto_renew)
     VALUES (?,1,?,?,1,'active',0)`,
  ).run(id, userId, purchasedAt);
  ctx.db.prepare(
    `INSERT INTO shop_purchase_title_provenance
       (purchase_id,user_id,product_key,purchased_at,origin,title_eligible)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    id,
    userId,
    options.productKey ?? `product-${id}`,
    purchasedAt,
    options.origin ?? "storefront",
    options.eligible === false ? 0 : 1,
  );
  return id;
}

function start(
  ctx: ReturnType<typeof setup>,
  observedAt: number,
  roleIds: readonly string[] = [SHOP_ROLE],
  manifest: RoleFamilyManifest = SHOP_MANIFEST,
): void {
  ctx.temporal.startObservationSession(
    "main",
    manifest,
    [{ userId: "alice", roleIds, bot: false }],
    observedAt,
  );
}

function payload(ctx: ReturnType<typeof setup>, observedAt: number, userId = "alice") {
  const resolved = resolveTitleScope(ctx.store, RULE.definition, observedAt);
  return readTitleSource(ctx.db, "shop_role_purchase_safe", userId, resolved);
}

describe("F3b domain role truth audit / source contracts", () => {
  it("shopだけをactual /商館 authorization keyからtag付けし、名称heuristicやrole slotsを使わない", () => {
    const ctx = setup();
    const departments = new Departments(ctx.db, new Ledger(ctx.db));
    const settings = new Settings(ctx.db);
    departments.upsert("冥界商館", "名称は変更可能", SHOP_ROLE);
    departments.upsert("賭場スタッフという名前だけ", "賭場", "role-casino-name");
    departments.upsert("銀行という名前だけ", "銀行", "role-bank-name");
    settings.set("roles:room_normal_free", ["role-room-benefit"], "test");
    settings.set("roles:casino_pvp_notify", ["role-casino-notify"], "test");
    expect(buildPublicDepartmentRoleFamilyManifest(ctx.db)).toEqual({
      provenance: "departments_snapshot",
      families: [
        { familyKey: "department:冥界商館", roleIds: [SHOP_ROLE], tags: ["public_department", "shop"] },
        { familyKey: "department:賭場スタッフという名前だけ", roleIds: ["role-casino-name"], tags: ["public_department"] },
        { familyKey: "department:銀行という名前だけ", roleIds: ["role-bank-name"], tags: ["public_department"] },
      ],
    });
    expect(Object.entries(CANONICAL_DEPARTMENT_DOMAIN_TAGS)).toEqual([["冥界商館", ["shop"]]]);
    expect(Object.isFrozen(CANONICAL_DEPARTMENT_DOMAIN_TAGS)).toBe(true);
    expect(Object.isFrozen(CANONICAL_DEPARTMENT_DOMAIN_TAGS["冥界商館"])).toBe(true);
  });

  it("restricted interval helperとsafe shop sourceのprivacy/derivation contractを固定する", () => {
    expect(TITLE_SOURCES.role_family_domain_intervals).toMatchObject({
      origin: "derived",
      privacy: "restricted",
      titleUsable: false,
      restrictedUse: "role_domain_temporal_classification",
    });
    expect(TITLE_SOURCES.shop_role_purchase_safe).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      derivedFrom: ["shop_purchase_title_records", "role_family_domain_intervals"],
    });
  });
});

describe("A-J common role-at-action semantics through No.65", () => {
  it("A/B/C/E. role interval内だけを採用し、同じJST日の前後はJOINしない", () => {
    const ctx = setup();
    purchase(ctx, "alice", BASE + 5);
    start(ctx, BASE + 10);
    purchase(ctx, "alice", BASE + 15);
    ctx.temporal.observeMemberSnapshot("main", { userId: "alice", roleIds: [], bot: false }, BASE + 20);
    purchase(ctx, "alice", BASE + 25);
    ctx.temporal.checkpoint("main", BASE + 30);
    expect(payload(ctx, BASE + 31)).toEqual({
      days: [{ date: "2026-08-01", eligiblePurchaseCount: 1 }],
    });
  });

  it("D. role transitionとpurchaseがsame secondならfail closed", () => {
    const startBoundary = setup();
    start(startBoundary, BASE + 10);
    purchase(startBoundary, "alice", BASE + 10);
    startBoundary.temporal.checkpoint("main", BASE + 20);
    expect(payload(startBoundary, BASE + 21)).toEqual({ days: [] });

    const endBoundary = setup();
    start(endBoundary, BASE);
    endBoundary.temporal.observeMemberSnapshot(
      "main",
      { userId: "alice", roleIds: [], bot: false },
      BASE + 10,
    );
    purchase(endBoundary, "alice", BASE + 10);
    endBoundary.temporal.checkpoint("main", BASE + 20);
    expect(payload(endBoundary, BASE + 21)).toEqual({ days: [] });
  });

  it("F. restart UNKNOWN gap中のpurchaseは0", () => {
    const ctx = setup();
    start(ctx, BASE);
    ctx.temporal.checkpoint("main", BASE + 10);
    ctx.temporal.recoverDangling("main");
    purchase(ctx, "alice", BASE + 20);
    start(ctx, BASE + 40);
    ctx.temporal.checkpoint("main", BASE + 50);
    expect(payload(ctx, BASE + 51)).toEqual({ days: [] });
  });

  it("G. disconnect UNKNOWN gap中のpurchaseは0", () => {
    const ctx = setup();
    start(ctx, BASE);
    ctx.temporal.suspendGuild("main", BASE + 10, "disconnect");
    purchase(ctx, "alice", BASE + 20);
    start(ctx, BASE + 40);
    ctx.temporal.checkpoint("main", BASE + 50);
    expect(payload(ctx, BASE + 51)).toEqual({ days: [] });
  });

  it("H/AX/AY. manifest revision変更はold actionを書き換えずfresh snapshot前をUNKNOWNにする", () => {
    const ctx = setup();
    start(ctx, BASE);
    purchase(ctx, "alice", BASE + 10);
    ctx.temporal.invalidateManifest("main", BASE + 20);
    purchase(ctx, "alice", BASE + 25);
    start(ctx, BASE + 30, [SHOP_ROLE], NON_DOMAIN_MANIFEST);
    purchase(ctx, "alice", BASE + 40);
    ctx.temporal.checkpoint("main", BASE + 50);
    expect(payload(ctx, BASE + 51)).toEqual({
      days: [{ date: "2026-08-01", eligiblePurchaseCount: 1 }],
    });
  });

  it("I. current role相当の情報だけでhistorical intervalが無ければ0", () => {
    const ctx = setup();
    new Departments(ctx.db, new Ledger(ctx.db)).upsert("冥界商館", "shop", SHOP_ROLE);
    purchase(ctx, "alice", BASE + 10);
    expect(payload(ctx, BASE + 20)).toEqual({ days: [] });
  });

  it("J. observedAt後のrole/action/refundはsnapshotへ漏れない", () => {
    const ctx = setup();
    start(ctx, BASE);
    ctx.temporal.checkpoint("main", BASE + 40);
    const before = purchase(ctx, "alice", BASE + 10);
    purchase(ctx, "alice", BASE + 30);
    ctx.db.prepare(
      `INSERT INTO shop_purchase_status_history (purchase_id,status,occurred_at)
       VALUES (?,'refunded',?)`,
    ).run(before, BASE + 25);
    expect(payload(ctx, BASE + 20)).toEqual({
      days: [{ date: "2026-08-01", eligiblePurchaseCount: 1 }],
    });
    expect(payload(ctx, BASE + 35)).toEqual({
      days: [{ date: "2026-08-01", eligiblePurchaseCount: 1 }],
    });
  });
});

describe("No.65 AA-AH and common interval helper", () => {
  it("AA/AF/AG. role中の複数purchaseを件数・JST day distributionのまま保持する", () => {
    const ctx = setup();
    start(ctx, BASE);
    purchase(ctx, "alice", BASE + DAY + 10);
    purchase(ctx, "alice", BASE + DAY + 20, { productKey: "same-product" });
    purchase(ctx, "alice", BASE + 2 * DAY + 10);
    ctx.temporal.checkpoint("main", BASE + 3 * DAY);
    expect(payload(ctx, BASE + 3 * DAY)).toEqual({
      days: [
        { date: "2026-08-02", eligiblePurchaseCount: 2 },
        { date: "2026-08-03", eligiblePurchaseCount: 1 },
      ],
    });
  });

  it("AB/AC. role開始前またはineligible origin/itemは0", () => {
    const ctx = setup();
    purchase(ctx, "alice", BASE + 5);
    start(ctx, BASE + 10);
    purchase(ctx, "alice", BASE + 15, { eligible: false });
    purchase(ctx, "alice", BASE + 16, { origin: "reevaluation" });
    ctx.temporal.checkpoint("main", BASE + 20);
    expect(payload(ctx, BASE + 21)).toEqual({ days: [] });
  });

  it("AD/AE. refund/cancelは既存snapshot contractを共有しfuture occurrenceは過去を書き換えない", () => {
    const ctx = setup();
    start(ctx, BASE);
    ctx.temporal.checkpoint("main", BASE + 40);
    const refunded = purchase(ctx, "alice", BASE + 10);
    const cancelled = purchase(ctx, "alice", BASE + 11);
    ctx.db.prepare(
      `INSERT INTO shop_purchase_status_history (purchase_id,status,occurred_at)
       VALUES (?,'refunded',?), (?,'cancelled',?)`,
    ).run(refunded, BASE + 20, cancelled, BASE + 30);
    expect(payload(ctx, BASE + 15).days[0]?.eligiblePurchaseCount).toBe(2);
    expect(payload(ctx, BASE + 25).days[0]?.eligiblePurchaseCount).toBe(1);
    expect(payload(ctx, BASE + 35)).toEqual({ days: [] });
  });

  it("corrupt session/revision provenanceはsubject全体をfail closedにする", () => {
    const ctx = setup();
    start(ctx, BASE);
    purchase(ctx, "alice", BASE + 10);
    ctx.temporal.checkpoint("main", BASE + 20);
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.prepare(`UPDATE role_observation_sessions SET manifest_revision_id = 999 WHERE guild_id = 'main'`).run();
    expect(computeShopRolePurchaseSafe(ctx.db, { start: BASE, end: BASE + 21 }, ["alice"])[0]!.payload).toEqual({ days: [] });
  });

  it("interval helperはpositive overlapだけを返しboundary touchを数えない", () => {
    expect(intersectTrustedRoleFamilyIntervals(
      [{ familyKey: "inn", start: BASE + 10, end: BASE + 20 }],
      BASE + 15,
      BASE + 25,
    )).toEqual([{ familyKey: "inn", start: BASE + 15, end: BASE + 20 }]);
    expect(intersectTrustedRoleFamilyIntervals(
      [{ familyKey: "inn", start: BASE + 10, end: BASE + 20 }],
      BASE + 20,
      BASE + 30,
    )).toEqual([]);
  });

  it("safe payloadはdate/countだけでidentity・timestamp・itemを出さずdeep-freeze", () => {
    const ctx = setup();
    start(ctx, BASE);
    purchase(ctx, "LEAK_USER", BASE + 10, { productKey: "LEAK_PRODUCT" });
    // LEAK_USERにはrole presenceが無いので、alice向けにroleを観測し直して対象factを作る。
    ctx.temporal.observeMemberSnapshot("main", { userId: "LEAK_USER", roleIds: [SHOP_ROLE], bot: false }, BASE + 1);
    ctx.temporal.checkpoint("main", BASE + 20);
    const result = payload(ctx, BASE + 21, "LEAK_USER");
    expect(result).toEqual({ days: [{ date: "2026-08-01", eligiblePurchaseCount: 1 }] });
    const json = JSON.stringify(result);
    for (const marker of ["LEAK_USER", "LEAK_PRODUCT", SHOP_ROLE, "冥界商館", String(BASE + 10)]) {
      expect(json).not.toContain(marker);
    }
    expect(Object.keys(result)).toEqual(["days"]);
    expect(Object.keys(result.days[0]!)).toEqual(["date", "eligiblePurchaseCount"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.days)).toBe(true);
  });
});

describe("bulk", () => {
  it("601 subjectsを300/300/1で読み、single readerとprefetched readerを一致させる", () => {
    const ctx = setup();
    const userIds = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    ctx.temporal.startObservationSession(
      "main",
      SHOP_MANIFEST,
      userIds.map((userId) => ({ userId, roleIds: [SHOP_ROLE], bot: false })),
      BASE,
    );
    purchase(ctx, userIds[0]!, BASE + 10);
    purchase(ctx, userIds[600]!, BASE + 11);
    ctx.temporal.checkpoint("main", BASE + 20);
    const resolved = resolveTitleScope(ctx.store, RULE.definition, BASE + 21);
    const bulk = new TitleSourceCache();
    expect(bulk.prefetch(ctx.db, "shop_role_purchase_safe", userIds, resolved)).toEqual({
      loaded: 601,
      readCalls: 3,
    });
    const single = new TitleSourceCache();
    for (const userId of [userIds[0]!, userIds[300]!, userIds[600]!]) {
      expect(bulk.get(ctx.db, "shop_role_purchase_safe", userId, resolved)).toEqual(
        single.get(ctx.db, "shop_role_purchase_safe", userId, resolved),
      );
    }
  });
});
