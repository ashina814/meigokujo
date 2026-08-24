import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes, registerTxType } from "../src/ledger/registry.js";
import { Shop } from "../src/shop/service.js";
import { ECONOMY_FEATURE_FAMILY_MANIFEST } from "../src/titles/v2-economy.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

registerDefaultTxTypes();

const DAY = 86_400;
const BASE = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1_000);
const COMMON = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" as const },
};
const ECONOMY_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.economy-semantic-safe",
    name: "test",
    description: "test",
    sources: ["economy_semantic_safe"] as const,
    triggers: ["economy_activity"],
    lifecycle: "active",
    ...COMMON,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);
const SHOP_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.shop-purchase-safe",
    name: "test",
    description: "test",
    sources: ["shop_purchase_safe"] as const,
    triggers: ["economy_activity"],
    lifecycle: "active",
    ...COMMON,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1_000));
});
afterEach(() => vi.useRealTimers());

let sequence = 0;
function setup() {
  const db = openDb(":memory:");
  let clock = BASE - 10 * DAY;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test" });
  clock = BASE + 100 * DAY;
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  return { db, store, ledger, shop };
}
function at(timestamp: number): void {
  vi.setSystemTime(new Date(timestamp * 1_000));
}
function scope(ctx: ReturnType<typeof setup>, observedAt: number, kind: "economy" | "shop" = "economy") {
  return resolveTitleScope(ctx.store, kind === "economy" ? ECONOMY_RULE.definition : SHOP_RULE.definition, observedAt);
}
function fund(ledger: Ledger, userId: string, timestamp = BASE, amount = 1_000_000): void {
  at(timestamp);
  const account = `user:${userId}`;
  ledger.ensureAccount(account, "user");
  sequence += 1;
  ledger.transfer({
    from: TREASURY,
    to: account,
    amount,
    type: "initial",
    actor: "system:test",
    idempotencyKey: `fund:${userId}:${sequence}`,
  });
}
function peer(
  ledger: Ledger,
  fromUserId: string,
  toUserId: string,
  type: "transfer" | "tip",
  timestamp: number,
) {
  fund(ledger, fromUserId, timestamp - 1);
  at(timestamp);
  ledger.ensureAccount(`user:${toUserId}`, "user");
  sequence += 1;
  return ledger.transfer({
    from: `user:${fromUserId}`,
    to: `user:${toUserId}`,
    amount: 100,
    type,
    actor: `user:${fromUserId}`,
    idempotencyKey: `peer:${sequence}`,
  });
}
function normalItem(ctx: ReturnType<typeof setup>, name: string, opts: { alt?: boolean } = {}) {
  at(BASE);
  return ctx.shop.createItem(
    {
      name,
      price_land: opts.alt ? null : 1_000,
      price_alt_kind: opts.alt ? "invite" : null,
      price_alt_amount: opts.alt ? 1 : null,
      kind: "one_shot",
      delivery: "manual",
    },
    "staff",
  );
}
function buy(
  ctx: ReturnType<typeof setup>,
  userId: string,
  itemId: number,
  timestamp: number,
  opts: { alt?: boolean; key?: string } = {},
) {
  if (!opts.alt) fund(ctx.ledger, userId, timestamp - 1);
  at(timestamp);
  return ctx.shop.purchase({
    itemId,
    userId,
    actor: `user:${userId}`,
    memberRoleIds: [],
    payAlt: opts.alt,
    idempotencyKey: opts.key ?? `purchase:${userId}:${itemId}:${timestamp}:${sequence++}`,
  });
}

describe("F2k source contracts / explicit manifest", () => {
  it("raw shop provenanceはrestricted、2つのderived sourceはsafeで自動manifest拡張しない", () => {
    expect(TITLE_SOURCES.shop_purchase_title_records).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      restrictedUse: "economy_safe_classification",
    });
    expect(TITLE_SOURCES.shop_purchase_safe).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      derivedFrom: ["shop_purchase_title_records"],
    });
    expect(TITLE_SOURCES.economy_semantic_safe).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      derivedFrom: ["ledger_transactions", "shop_purchase_title_records"],
    });
    expect(Object.keys(ECONOMY_FEATURE_FAMILY_MANIFEST)).toEqual(["peer_transfer", "tip", "shop"]);
  });
});

describe("Economy regressions A–P", () => {
  it("A–E: normal tip/transferのin/outとdistinct human breadthをexactに表す", () => {
    const ctx = setup();
    peer(ctx.ledger, "alice", "bob", "tip", BASE + DAY);
    peer(ctx.ledger, "carol", "alice", "transfer", BASE + 2 * DAY);
    for (let index = 0; index < 99; index += 1) peer(ctx.ledger, "alice", "bob", "tip", BASE + 3 * DAY + index);
    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 4 * DAY));
    expect(payload.hasNaturalInflow).toBe(true);
    expect(payload.hasNaturalOutflow).toBe(true);
    expect(payload.distinctHumanCounterparts).toBe(2);
    expect(payload.outgoingTip.distinctRecipients).toBe(1);
  });

  it("F–J/M: excluded/unknown/reversal transactionはmanifest familyへ入らない", () => {
    const ctx = setup();
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.ensureAccount("user:bob", "user");
    ctx.ledger.ensureAccount("sys:test", "system");
    const excluded = [
      "salary", "reward_bump", "pension", "event_prize", "fine", "tax", "adjust", "bet", "prize",
      "chip_deposit", "chip_redeem", "ether_buy", "casino_remittance", "tip_burn",
    ];
    const insert = ctx.db.prepare(
      `INSERT INTO transactions
         (idempotency_key,from_account,to_account,amount,type,actor_id,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    excluded.forEach((type, index) => {
      const outgoing = !["salary", "reward_bump", "pension", "event_prize", "prize", "chip_redeem"].includes(type);
      insert.run(
        `excluded:${index}`,
        outgoing ? "user:alice" : "sys:test",
        outgoing ? "sys:test" : "user:alice",
        1,
        type,
        outgoing ? "user:alice" : "sys:test",
        BASE + DAY + index,
      );
    });
    registerTxType("future_economy_type", { fromKinds: ["user"], toKinds: ["user"], publicLog: true });
    insert.run("unknown", "user:alice", "user:bob", 1, "future_economy_type", "user:alice", BASE + 2 * DAY);
    expect(readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 3 * DAY))).toMatchObject({
      days: [],
      distinctFamilies: 0,
      distinctHumanCounterparts: 0,
    });
  });

  it("K/L: originalはsnapshot内reversal後に除外し、future reversalはhistorical snapshotを変えない", () => {
    const ctx = setup();
    const original = peer(ctx.ledger, "alice", "bob", "transfer", BASE + DAY);
    at(BASE + 3 * DAY);
    ctx.ledger.reverse(original.tx.id, "staff", "reversal");
    expect(readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 2 * DAY)).distinctFamilies).toBe(1);
    expect(readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 4 * DAY)).distinctFamilies).toBe(0);
  });

  it("N/O: 同じfamilyの複数actionとshop下層tip_burnはfamily breadthを水増ししない", () => {
    const ctx = setup();
    peer(ctx.ledger, "alice", "bob", "tip", BASE + DAY);
    peer(ctx.ledger, "alice", "carol", "tip", BASE + DAY + 1);
    const item = normalItem(ctx, "normal-land");
    const altItem = normalItem(ctx, "normal-alt", { alt: true });
    buy(ctx, "alice", item.id, BASE + 2 * DAY);
    buy(ctx, "alice", altItem.id, BASE + 2 * DAY + 1, { alt: true });
    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 3 * DAY));
    expect(payload.distinctFamilies).toBe(2);
    expect(payload.days.find((day) => day.families.includes("shop"))?.families).toEqual(["shop"]);
    expect(payload.days.flatMap((day) => day.families)).not.toContain("tip_burn");
  });

  it("P: multiple day/family/direction/human breadthをthreshold未固定で同時表現する", () => {
    const ctx = setup();
    peer(ctx.ledger, "bob", "alice", "transfer", BASE + DAY);
    peer(ctx.ledger, "alice", "carol", "tip", BASE + 2 * DAY);
    const item = normalItem(ctx, "normal");
    buy(ctx, "alice", item.id, BASE + 3 * DAY);
    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 4 * DAY));
    expect(payload).toMatchObject({
      distinctFamilies: 3,
      distinctHumanCounterparts: 2,
      hasNaturalInflow: true,
      hasNaturalOutflow: true,
    });
    expect(payload.days).toHaveLength(3);
  });
});

describe("No.63 subject-initiated semantic family breadth", () => {
  it("incoming transfer + incoming tip onlyはoverall 2 familyだがsubject-used breadth 0", () => {
    const ctx = setup();
    peer(ctx.ledger, "bob", "alice", "transfer", BASE + DAY);
    peer(ctx.ledger, "carol", "alice", "tip", BASE + 2 * DAY);

    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 3 * DAY));
    expect(payload.distinctFamilies).toBe(2);
    expect(payload.subjectUsedFamilies).toEqual([]);
    expect(payload.distinctSubjectUsedFamilies).toBe(0);
    expect(payload.days.every((day) => day.subjectUsedFamilies.length === 0)).toBe(true);
  });

  it("outgoing transfer onlyはsubject-used peer_transfer 1", () => {
    const ctx = setup();
    peer(ctx.ledger, "alice", "bob", "transfer", BASE + DAY);

    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 2 * DAY));
    expect(payload.subjectUsedFamilies).toEqual(["peer_transfer"]);
    expect(payload.distinctSubjectUsedFamilies).toBe(1);
  });

  it("outgoing tip + storefront shopはsubject-used family breadth 2", () => {
    const ctx = setup();
    peer(ctx.ledger, "alice", "bob", "tip", BASE + DAY);
    const item = normalItem(ctx, "subject-used-shop");
    buy(ctx, "alice", item.id, BASE + 2 * DAY);

    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 3 * DAY));
    expect(payload.subjectUsedFamilies).toEqual(["tip", "shop"]);
    expect(payload.distinctSubjectUsedFamilies).toBe(2);
  });

  it("same JST dayのincoming transferとoutgoing tipでfamilyごとのdirectionを取り違えない", () => {
    const ctx = setup();
    peer(ctx.ledger, "bob", "alice", "transfer", BASE + DAY + 10);
    peer(ctx.ledger, "alice", "carol", "tip", BASE + DAY + 20);

    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 2 * DAY));
    expect(payload.days).toEqual([
      {
        date: "2026-08-02",
        families: ["peer_transfer", "tip"],
        subjectUsedFamilies: ["tip"],
        directions: ["inflow", "outflow"],
        distinctHumanCounterparts: 2,
      },
    ]);
    expect(payload.subjectUsedFamilies).toEqual(["tip"]);
    expect(payload.distinctSubjectUsedFamilies).toBe(1);
  });
});

describe("Shop regressions Q–AG", () => {
  it("Q/R: normal Land/alternative storefront purchaseはeligible fact", () => {
    const ctx = setup();
    const land = normalItem(ctx, "land");
    const alt = normalItem(ctx, "alt", { alt: true });
    buy(ctx, "alice", land.id, BASE + DAY);
    buy(ctx, "alice", alt.id, BASE + 2 * DAY, { alt: true });
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 3 * DAY, "shop"))).toEqual({
      days: [
        { date: "2026-08-02", distinctEligibleProducts: 1 },
        { date: "2026-08-03", distinctEligibleProducts: 1 },
      ],
      distinctEligibleProducts: 2,
    });
  });

  it("S: disabled/no-stock/role不足/no-price validation失敗はfact 0", () => {
    const ctx = setup();
    const disabled = normalItem(ctx, "disabled");
    ctx.shop.setEnabled(disabled.id, false, "staff");
    const noStock = ctx.shop.createItem({ name: "stock", price_land: 1, kind: "one_shot", delivery: "manual", stock: 0 }, "staff");
    const role = ctx.shop.createItem({ name: "role", price_land: 1, kind: "one_shot", delivery: "manual", require_role_id: "secret-role" }, "staff");
    const noPrice = ctx.shop.createItem({ name: "price", price_land: null, kind: "one_shot", delivery: "manual" }, "staff");
    fund(ctx.ledger, "alice");
    for (const item of [disabled, noStock, role, noPrice]) {
      expect(() => ctx.shop.purchase({ itemId: item.id, userId: "alice", actor: "user:alice", memberRoleIds: [] })).toThrow();
    }
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + DAY, "shop"))).toEqual({
      days: [],
      distinctEligibleProducts: 0,
    });
  });

  it("T–V: replay/同一商品反復はdistinct 1、別eligible商品は2", () => {
    const ctx = setup();
    const a = normalItem(ctx, "a");
    const b = normalItem(ctx, "b");
    buy(ctx, "alice", a.id, BASE + DAY, { key: "same-operation" });
    buy(ctx, "alice", a.id, BASE + DAY, { key: "same-operation" });
    buy(ctx, "alice", a.id, BASE + 2 * DAY, { key: "new-operation" });
    buy(ctx, "alice", b.id, BASE + 2 * DAY + 1);
    const payload = readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 3 * DAY, "shop"));
    expect(payload.distinctEligibleProducts).toBe(2);
    expect(payload.days).toEqual([
      { date: "2026-08-02", distinctEligibleProducts: 1 },
      { date: "2026-08-03", distinctEligibleProducts: 2 },
    ]);
  });

  it("W/X: refund後snapshotだけ除外し、refund前fixed snapshotは後から変わらない", () => {
    const ctx = setup();
    const item = normalItem(ctx, "refund");
    const purchase = buy(ctx, "alice", item.id, BASE + DAY).purchase;
    at(BASE + 3 * DAY);
    ctx.shop.refund(purchase.id, "failed", "staff");
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 2 * DAY, "shop")).distinctEligibleProducts).toBe(1);
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 4 * DAY, "shop")).distinctEligibleProducts).toBe(0);
  });

  it("Y: immutable cancel occurrence後だけ除外する", () => {
    const ctx = setup();
    const item = normalItem(ctx, "cancel");
    const purchase = buy(ctx, "alice", item.id, BASE + DAY).purchase;
    ctx.db.prepare("INSERT INTO shop_purchase_status_history (purchase_id,status,occurred_at) VALUES (?,'cancelled',?)")
      .run(purchase.id, BASE + 3 * DAY);
    ctx.db.prepare("UPDATE shop_purchases SET status='cancelled' WHERE id=?").run(purchase.id);
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 2 * DAY, "shop")).distinctEligibleProducts).toBe(1);
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 4 * DAY, "shop")).distinctEligibleProducts).toBe(0);
  });

  it("Y2: direct cancelもoccurrenceをcaptureし、provenance/status historyはappend-only", () => {
    const ctx = setup();
    const item = normalItem(ctx, "direct-cancel");
    const purchase = buy(ctx, "alice", item.id, BASE + DAY).purchase;

    ctx.db.prepare("UPDATE shop_purchases SET status='cancelled' WHERE id=?").run(purchase.id);
    expect(ctx.db.prepare(
      "SELECT status FROM shop_purchase_status_history WHERE purchase_id=?",
    ).get(purchase.id)).toEqual({ status: "cancelled" });

    expect(() => ctx.db.prepare(
      "UPDATE shop_purchase_title_provenance SET product_key='mutated' WHERE purchase_id=?",
    ).run(purchase.id)).toThrow(/append-only/);
    expect(() => ctx.db.prepare(
      "DELETE FROM shop_purchase_status_history WHERE purchase_id=?",
    ).run(purchase.id)).toThrow(/append-only/);
  });

  it("Z/AA/AB/AC: expired/pending/failedはpurchaseを消さず、later refundだけが消す", () => {
    const ctx = setup();
    const items = ["expired", "pending", "failed"].map((name) => normalItem(ctx, name));
    const purchases = items.map((item, index) => buy(ctx, "alice", item.id, BASE + DAY + index).purchase);
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(purchases[0]!.id);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='pending' WHERE id=?").run(purchases[1]!.id);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed' WHERE id=?").run(purchases[2]!.id);
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 2 * DAY, "shop")).distinctEligibleProducts).toBe(3);
    at(BASE + 3 * DAY);
    ctx.shop.refund(purchases[2]!.id, "delivery failed", "staff");
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 4 * DAY, "shop")).distinctEligibleProducts).toBe(2);
  });

  it("AD/AE: legacy migrationとprovenance無しoperator synthetic entitlementは0", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "legacy",
      price_land: 1,
      kind: "monthly",
      duration_days: 30,
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "legacy-role" }),
    }, "staff");
    ctx.shop.migrateTimedAccessLegacy({
      migrationKey: "legacy-run",
      expectations: [{ itemId: item.id, roleId: "legacy-role", expectedCount: 1, roleHolderIds: ["legacy-user"] }],
      actor: "staff",
      reason: "migration",
      startedAt: BASE + DAY,
    });
    ctx.db.prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew)
       VALUES (?,?,?,?,'active',0)`,
    ).run(item.id, "synthetic-user", BASE + DAY, 1);
    for (const userId of ["legacy-user", "synthetic-user"]) {
      expect(readTitleSource(ctx.db, "shop_purchase_safe", userId, scope(ctx, BASE + 2 * DAY, "shop"))).toEqual({
        days: [],
        distinctEligibleProducts: 0,
      });
    }
  });

  it("AF: item rename/update/disable後もpurchase時product identity/eligibilityは不変", () => {
    const ctx = setup();
    const a = normalItem(ctx, "before-a");
    const b = normalItem(ctx, "before-b");
    buy(ctx, "alice", a.id, BASE + DAY);
    buy(ctx, "alice", b.id, BASE + DAY + 1);
    ctx.shop.updateItem(a.id, { name: "after-a", price_land: 999_999 }, "staff");
    ctx.shop.setEnabled(b.id, false, "staff");
    expect(readTitleSource(ctx.db, "shop_purchase_safe", "alice", scope(ctx, BASE + 2 * DAY, "shop")).distinctEligibleProducts).toBe(2);
  });

  it("AG: raw item/purchase/price/request/delivery/user identityをsafe payloadへ出さずdeep-freeze", () => {
    const ctx = setup();
    const item = normalItem(ctx, "LEAK_ITEM_NAME");
    const purchase = buy(ctx, "LEAK_USER", item.id, BASE + DAY).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET request_json='LEAK_REQUEST' WHERE id=?").run(purchase.id);
    const payload = readTitleSource(ctx.db, "shop_purchase_safe", "LEAK_USER", scope(ctx, BASE + 2 * DAY, "shop"));
    const json = JSON.stringify(payload);
    for (const marker of ["LEAK_ITEM_NAME", "LEAK_USER", "LEAK_REQUEST", "shop-item:"]) {
      expect(json).not.toContain(marker);
    }
    expect(Object.keys(payload).sort()).toEqual(["days", "distinctEligibleProducts"]);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.days)).toBe(true);
    expect(Object.isFrozen(payload.days[0])).toBe(true);
  });
});

describe("No.59 regressions AH–AJ / bulk", () => {
  it("AH–AJ: tipだけのrecipient breadthとJST daysをtransferから分離する", () => {
    const ctx = setup();
    peer(ctx.ledger, "alice", "bob", "tip", BASE + DAY);
    peer(ctx.ledger, "alice", "bob", "tip", BASE + 2 * DAY);
    peer(ctx.ledger, "alice", "carol", "tip", BASE + 3 * DAY);
    peer(ctx.ledger, "alice", "transfer-only", "transfer", BASE + 4 * DAY);
    const payload = readTitleSource(ctx.db, "economy_semantic_safe", "alice", scope(ctx, BASE + 5 * DAY));
    expect(payload.outgoingTip).toEqual({
      days: [
        { date: "2026-08-02", distinctRecipients: 1 },
        { date: "2026-08-03", distinctRecipients: 1 },
        { date: "2026-08-04", distinctRecipients: 1 },
      ],
      distinctRecipients: 2,
    });
  });

  it("300超userをchunkしsingle/bulk payloadを一致させる", () => {
    const ctx = setup();
    const userIds = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    peer(ctx.ledger, userIds[0]!, "counterpart", "tip", BASE + DAY);
    peer(ctx.ledger, "sender", userIds[600]!, "transfer", BASE + DAY);
    const resolved = scope(ctx, BASE + 2 * DAY);
    const bulk = new TitleSourceCache();
    expect(bulk.prefetch(ctx.db, "economy_semantic_safe", userIds, resolved)).toEqual({
      loaded: 601,
      readCalls: 3,
    });
    const single = new TitleSourceCache();
    for (const userId of [userIds[0]!, userIds[300]!, userIds[600]!]) {
      expect(bulk.get(ctx.db, "economy_semantic_safe", userId, resolved)).toEqual(
        single.get(ctx.db, "economy_semantic_safe", userId, resolved),
      );
    }
  });
});
