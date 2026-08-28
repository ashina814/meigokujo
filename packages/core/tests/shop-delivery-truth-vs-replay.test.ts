import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Settings, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const USER = "777777777777777777";
const STAFF = "staff";
const START = 5_000_000;

/**
 * 「配送したか」と「自動で再実行してよいか」は別の問いである。
 *
 *   A. サービスは実際に提供されたか
 *   B. 自動配送を流し直しても安全か
 *
 * 購入時autoのスナップショットが証明するのは「自動配送のつもりだった」だけで、
 * 「成功した」ではない。一方で古いロール付与や期限延長を機械的に流し直すのは危険。
 * だからといって B を A の言葉（`delivery_state='delivered'`）で表現すると、
 * 返金や期限付きアクセスがその嘘を根拠にしてしまう。ここでは両者が分かれていることを固定する。
 */
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const settings = new Settings(db);
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: START,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:truth-replay",
  });
  return { db, ledger, events, settings, shop, setReevalItem: (id: number | null) => { reevalItemId = id; } };
}
type Ctx = ReturnType<typeof setup>;

const AUTO_ROLE = {
  delivery: "auto",
  delivery_kind: "add_role",
  delivery_data: JSON.stringify({ role_id: "r-vip", channel_id: "ch-vip" }),
};

const autoItem = (ctx: Ctx, over: Record<string, unknown> = {}) =>
  ctx.shop.createItem(
    { name: "期限つき入場券", price_land: 10_000, kind: "monthly", ...AUTO_ROLE, ...over } as never,
    STAFF,
  );

const snapshot = (kind = "add_role") =>
  JSON.stringify({ delivery: "auto", delivery_kind: kind, delivery_data: { role_id: "r-vip" }, captured_at: 1 });

/** 旧auto購入（provenanceなし・スナップショットあり・配送記録なし） */
function legacyAuto(ctx: Ctx, itemId: number, over: Record<string, unknown> = {}) {
  const purchasedAt = 1_700_000_000;
  const info = ctx.db
    .prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
        "delivery_snapshot_json,delivered_at,delivery_state,delivery_updated_at)" +
        " VALUES (?,?,?,?,?, 'active',0,?,NULL,?,?)",
    )
    .run(
      itemId,
      USER,
      purchasedAt,
      (over.expires_at as number | null | undefined) ?? null,
      10_000,
      (over.delivery_snapshot_json as string | undefined) ?? snapshot(),
      (over.delivery_state as string | undefined) ?? "delivered",
      purchasedAt,
    );
  return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
}

const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("返金 — 提供済みの根拠は強い証拠だけ", () => {
  it("移行由来の delivered（証拠なし）は「提供済み」として返金を拒まない。不明として止める", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id);
    const before = balance(ctx);

    expect(() => ctx.shop.refund(purchase.id, "運営が未提供と確認", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);

    // 資産も状態も一切動かない
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });

  it("実際の配送記録があれば ERR_ALREADY_DELIVERED", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id);
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { purchaseId: purchase.id } });

    expect(() => ctx.shop.refund(purchase.id, "やっぱり", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    ctx.db.close();
  });

  it("delivered_at があれば ERR_ALREADY_DELIVERED", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id);
    ctx.db.prepare("UPDATE shop_purchases SET delivered_at=? WHERE id=?").run(1_700_000_500, purchase.id);

    expect(() => ctx.shop.refund(purchase.id, "やっぱり", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    ctx.db.close();
  });

  it("新しい購入の delivered は従来どおり ERR_ALREADY_DELIVERED", () => {
    const ctx = setup();
    const item = ctx.shop.createItem(
      { name: "手動商品", price_land: 10_000, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const purchase = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;
    ctx.shop.completeManualDelivery(purchase.id, STAFF);

    expect(() => ctx.shop.refund(purchase.id, "やっぱり", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    ctx.db.close();
  });

  it("新しい未提供の購入は従来どおり返金できる", () => {
    const ctx = setup();
    const item = ctx.shop.createItem(
      { name: "手動商品", price_land: 10_000, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const before = balance(ctx);
    const purchase = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;

    ctx.shop.refund(purchase.id, "配送できなかった", STAFF);

    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("refunded");
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("代替支払を含む旧購入は、提供状況より先に「戻せない」で止まる", () => {
    // どちらも資産を動かさずに止めるが、理由は具体的な方を返す。
    // 何で払ったかは提供状況と無関係に分かっているため。
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id);
    ctx.db.prepare("UPDATE shop_purchases SET paid_land=NULL, paid_alt_kind='invite', paid_alt_amount=3 WHERE id=?").run(purchase.id);
    const before = balance(ctx);

    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    ctx.db.close();
  });
});

describe("自動再実行 — 結末が不明な旧autoは流し直さない", () => {
  it("結末不明の旧autoは、状態が pending でも再配送候補にならない", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id, { delivery_state: "pending" });

    expect(ctx.shop.isLegacyAutoOutcomeUnknown(purchase.id)).toBe(true);
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(purchase.id);
    ctx.db.close();
  });

  it("抑止台帳に載っていれば、他の条件を満たしても候補にならない", () => {
    const ctx = setup();
    const item = autoItem(ctx);
    const purchase = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed' WHERE id=?").run(purchase.id);
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).toContain(purchase.id);

    ctx.db
      .prepare("INSERT INTO shop_delivery_replay_suppressions (purchase_id,reason,created_at) VALUES (?,?,?)")
      .run(purchase.id, "test", 1);

    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(purchase.id);
    ctx.db.close();
  });

  it("新しい自動配送の失敗は、これまでどおり再試行候補に出る", () => {
    const ctx = setup();
    const item = autoItem(ctx);
    const purchase = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed', delivery_error='boom' WHERE id=?").run(purchase.id);

    expect(ctx.shop.isLegacyAutoOutcomeUnknown(purchase.id)).toBe(false);
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).toContain(purchase.id);
    ctx.db.close();
  });

  it("撤回済みの配送種別は、これまでどおり再試行しない", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id, {
      delivery_snapshot_json: snapshot("revoke_meirei"),
      delivery_state: "failed",
    });

    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(purchase.id);
    ctx.db.close();
  });

  it("結末不明の旧autoは「提供済み」でもない（真実と抑止が別々に成り立つ）", () => {
    const ctx = setup();
    const purchase = legacyAuto(ctx, autoItem(ctx).id);

    // 提供済みではない（返金は不明として止まる）
    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
    // かつ自動再実行もしない
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(purchase.id);
    // 運営には見える
    expect(ctx.shop.countLegacyAutoOutcomeUnknown()).toBe(1);
    expect(ctx.shop.listLegacyAutoOutcomeUnknown().map((r) => r.id)).toEqual([purchase.id]);
    ctx.db.close();
  });
});

describe("期限つきアクセス — 移行推定でロールを配り直さない", () => {
  function legacyNoSnapshot(ctx: Ctx, itemId: number, deliveredAt: number | null) {
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state,delivery_updated_at)" +
          " VALUES (?,?,?,?,?, 'active',0,NULL,?, 'delivered',?)",
      )
      .run(itemId, USER, 1_700_000_000, 4_000_000_000, 10_000, deliveredAt, 1_700_000_000);
    return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
  }

  it("移行推定の delivered だけでは有効な契約にならない", () => {
    const ctx = setup();
    const purchase = legacyNoSnapshot(ctx, autoItem(ctx).id, null);

    expect(ctx.shop.listActiveTimedAccess(USER).map((g) => g.purchase.id)).not.toContain(purchase.id);
    ctx.db.close();
  });

  it("実際に配送した証拠があれば、これまでどおり互換維持する", () => {
    const ctx = setup();
    const purchase = legacyNoSnapshot(ctx, autoItem(ctx).id, 1_700_000_500);

    expect(ctx.shop.listActiveTimedAccess(USER).map((g) => g.purchase.id)).toContain(purchase.id);
    ctx.db.close();
  });

  it("配送eventでも互換維持の根拠になる", () => {
    const ctx = setup();
    const purchase = legacyNoSnapshot(ctx, autoItem(ctx).id, null);
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { purchaseId: purchase.id } });

    expect(ctx.shop.listActiveTimedAccess(USER).map((g) => g.purchase.id)).toContain(purchase.id);
    ctx.db.close();
  });
});

describe("配送eventの照合は厳密に", () => {
  function legacyRow(ctx: Ctx) {
    return legacyAuto(ctx, autoItem(ctx).id);
  }

  /** payload をJSONリテラルとして直接書き込む（型まで指定したいので JSON.stringify を使わない） */
  function rawDeliveredEvent(ctx: Ctx, purchaseIdLiteral: string) {
    ctx.db
      .prepare("INSERT INTO events (type,actor_id,target_id,payload_json,created_at) VALUES ('shop_delivered',?,NULL,?,1)")
      .run(STAFF, `{"purchaseId":${purchaseIdLiteral}}`);
  }

  it("同じ購入IDの正しいJSONだけが証拠になる", () => {
    const ctx = setup();
    const purchase = legacyRow(ctx);
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { purchaseId: purchase.id } });
    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    ctx.db.close();
  });

  it("別の購入IDのeventは証拠にならない", () => {
    const ctx = setup();
    const purchase = legacyRow(ctx);
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { purchaseId: purchase.id + 1 } });
    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
    ctx.db.close();
  });

  it("IDを含む文字列があるだけでは証拠にならない", () => {
    const ctx = setup();
    const purchase = legacyRow(ctx);
    // 本文にIDが出てくるだけのpayload。部分一致だとこれが証拠に見えてしまう。
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { note: `purchaseId:${purchase.id} を確認` } });
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { otherPurchaseId: purchase.id } });
    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
    ctx.db.close();
  });

  // SQLiteの比較はaffinityで寄せるので、`json_type` を確認しないと
  // `"5"`（文字列）も `5.0`（実数）も 5 に一致してしまう。この event は
  // 返金拒否・期限つきアクセス復元・legacy分類の証拠境界なので、
  // 「5に見える値」ではなく「purchaseIdという整数が正確に5」を要求する。
  const NON_INTEGER: Array<[string, string]> = [
    ["JSON文字列", '"5"'],
    ["JSON実数", "5.0"],
  ];

  for (const [label, literal] of NON_INTEGER) {
    it(`purchaseId が ${label} のeventは証拠にならない（返金）`, () => {
      const ctx = setup();
      const purchase = legacyRow(ctx);
      rawDeliveredEvent(ctx, literal.replace("5", String(purchase.id)));

      expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
      ctx.db.close();
    });

    it(`purchaseId が ${label} のeventは証拠にならない（結末不明のまま）`, () => {
      const ctx = setup();
      const purchase = legacyRow(ctx);
      rawDeliveredEvent(ctx, literal.replace("5", String(purchase.id)));

      expect(ctx.shop.isLegacyAutoOutcomeUnknown(purchase.id)).toBe(true);
      expect(ctx.shop.countLegacyAutoOutcomeUnknown()).toBe(1);
      // 自動再実行もしない（真実と抑止が同時に成り立つ）
      expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(purchase.id);
      ctx.db.close();
    });

    it(`purchaseId が ${label} のeventでは期限つきアクセスを復元しない`, () => {
      const ctx = setup();
      const item = autoItem(ctx);
      const info = ctx.db
        .prepare(
          "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
            "delivery_snapshot_json,delivered_at,delivery_state,delivery_updated_at)" +
            " VALUES (?,?,?,?,?, 'active',0,NULL,NULL,'delivered',?)",
        )
        .run(item.id, USER, 1_700_000_000, 4_000_000_000, 10_000, 1_700_000_000);
      const purchaseId = Number(info.lastInsertRowid);
      rawDeliveredEvent(ctx, literal.replace("5", String(purchaseId)));

      expect(ctx.shop.listActiveTimedAccess(USER).map((g) => g.purchase.id)).not.toContain(purchaseId);
      ctx.db.close();
    });
  }

  it("整数として記録されていれば、これまでどおり証拠になる", () => {
    const ctx = setup();
    const purchase = legacyRow(ctx);
    rawDeliveredEvent(ctx, String(purchase.id));

    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    expect(ctx.shop.isLegacyAutoOutcomeUnknown(purchase.id)).toBe(false);
    ctx.db.close();
  });

  it("壊れたJSONでも例外にならず、証拠にもならない", () => {
    const ctx = setup();
    const purchase = legacyRow(ctx);
    ctx.db
      .prepare("INSERT INTO events (type,actor_id,target_id,payload_json,created_at) VALUES ('shop_delivered',?,NULL,?,1)")
      .run(STAFF, `{"purchaseId":${purchase.id}`); // 閉じ括弧なし

    expect(() => ctx.shop.refund(purchase.id, "x", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
    expect(ctx.shop.countLegacyAutoOutcomeUnknown()).toBe(1);
    ctx.db.close();
  });
});

describe("専用サービスの消費状態が、移行推定で汚染されない", () => {
  it("旧schemaの再評価権は、移行後も「消費済み」にならない", () => {
    // 再評価商品は delivery='manual' かつスナップショットは revoke_meirei（撤回種別）。
    // どちらの経路でも移行は delivered を書かないので、未消費の面談権が
    // 「もう面談を受けた」ことにされない。ここを固定しておく。
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-reeval-legacy-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "bot.db");

    const first = openDb(dbPath);
    const shop0 = new Shop(first, new Ledger(first), new EventLog(first));
    const item = shop0.createItem(
      { name: "再評価チャレンジ", price_land: 500_000, price_alt_kind: "invite", price_alt_amount: 5, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const withSnapshot = Number(
      first
        .prepare(
          "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at)" +
            " VALUES (?,?,?,?, 'active',0,?,NULL)",
        )
        .run(item.id, USER, 1_700_000_000, 500_000, snapshot("revoke_meirei")).lastInsertRowid,
    );
    const withoutSnapshot = Number(
      first
        .prepare(
          "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at)" +
            " VALUES (?,?,?,?, 'active',0,NULL,NULL)",
        )
        .run(item.id, USER, 1_700_000_000, 500_000).lastInsertRowid,
    );
    first.prepare("UPDATE shop_purchases SET delivery_state=NULL, delivery_updated_at=NULL").run();
    first.close();

    const db = openDb(dbPath);
    const shop = new Shop(db, new Ledger(db), new EventLog(db));
    for (const id of [withSnapshot, withoutSnapshot]) {
      const row = shop.getPurchase(id)!;
      // 消費済み（delivered）にされていない = 面談権として使える
      expect(row.delivery_state).not.toBe("delivered");
      expect(row.delivered_at).toBeNull();
    }
    // 撤回種別を持つ方は再評価の実績として認識される（Phase Bのsemantic判定）
    expect(shop.isReevaluationPurchase(withSnapshot)).toBe(true);
    // どちらも普通の手動キューには出ない
    expect(shop.countPendingManual()).toBe(0);
    db.close();
  });
});

describe("旧schemaからの移行（結末不明のauto）", () => {
  function migrated(kind: string) {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-truth-replay-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "bot.db");
    const first = openDb(dbPath);
    const shop = new Shop(first, new Ledger(first), new EventLog(first));
    const item = shop.createItem(
      { name: "旧auto商品", price_land: 10_000, kind: "monthly", ...AUTO_ROLE } as never,
      STAFF,
    );
    const info = first
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at)" +
          " VALUES (?,?,?,?, 'active',0,?,NULL)",
      )
      .run(item.id, USER, 1_700_000_000, 10_000, snapshot(kind));
    const purchaseId = Number(info.lastInsertRowid);
    first.prepare("UPDATE shop_purchases SET delivery_state=NULL, delivery_updated_at=NULL WHERE id=?").run(purchaseId);
    first.close();
    const db = openDb(dbPath);
    return { db, shop: new Shop(db, new Ledger(db), new EventLog(db)), purchaseId };
  }

  it("提供済みと書かず、自動再実行もせず、運営には見える", () => {
    const ctx = migrated("add_role");
    const row = ctx.shop.getPurchase(ctx.purchaseId)!;

    // 事実として「提供済み」と書かない
    expect(row.delivery_state).not.toBe("delivered");
    // 自動では流し直さない
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(ctx.purchaseId);
    const suppression = ctx.db
      .prepare("SELECT reason FROM shop_delivery_replay_suppressions WHERE purchase_id=?")
      .get(ctx.purchaseId) as { reason: string } | undefined;
    expect(suppression?.reason).toBe("legacy_auto_outcome_unknown");
    // 普通の手動キューにも入れない
    expect(ctx.shop.countPendingManual()).toBe(0);
    // 運営には見える
    expect(ctx.shop.countLegacyAutoOutcomeUnknown()).toBe(1);
    ctx.db.close();
  });

  it("実際の配送証拠がある旧autoは、提供済みとして扱い再実行もしない", () => {
    const ctx = migrated("add_role");
    ctx.db
      .prepare("INSERT INTO events (type,actor_id,target_id,payload_json,created_at) VALUES ('shop_delivered',?,NULL,?,1)")
      .run(STAFF, JSON.stringify({ purchaseId: ctx.purchaseId }));

    expect(ctx.shop.isLegacyAutoOutcomeUnknown(ctx.purchaseId)).toBe(false);
    expect(ctx.shop.countLegacyAutoOutcomeUnknown()).toBe(0);
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(ctx.purchaseId);
    ctx.db.close();
  });
});
