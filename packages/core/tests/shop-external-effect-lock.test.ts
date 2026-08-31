import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * **衝突する単位は購入ではなく、外部効果そのもの。**
 *
 * `shop_external_delivery_attempts` の部分ユニーク索引は `purchase_id` にかかって
 * いるので、同じロールを与える契約が2つあると**両方が live claim を持てる**。
 * 実際に衝突するのは Discord の `(guild, user, role)` なので、そこに鍵を置く。
 *
 * ここで確かめるのは鍵の意味だけ:
 *   - 生きている所有者は常に1人
 *   - 自分のトークンでしか動かせない
 *   - 結果が分からないものを「失敗」にしない
 *   - **鍵は「提供された」の証拠ではない**
 */

registerDefaultTxTypes();
const USER = "u-lock";
const ROLE = "r-vip";
const GUILD = "g-main";
const KEY = Shop.discordRoleAddEffectKey(GUILD, USER, ROLE);

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY, to: `user:${USER}`, amount: 10_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:lock",
  });
  const mk = (name: string) =>
    shop.createItem(
      {
        name, price_land: 100, kind: "monthly", duration_days: 30,
        delivery: "auto", delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: ROLE }),
      } as never,
      "staff",
    );
  return { db, ledger, events, shop, mk };
}
type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx, itemId: number) =>
  ctx.shop.purchase({
    itemId, userId: USER, actor: `user:${USER}`, memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;

const acquire = (ctx: Ctx, owner: string, purchaseId?: number) =>
  ctx.shop.acquireExternalEffectLock({ scope: "discord_role_add", key: KEY, owner, purchaseId });

// ── 鍵の単位 ─────────────────────────────────────────────────────────────────

describe("鍵の単位は購入ではなく外部効果", () => {
  it("同じキーの所有者は同時に1人だけ", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    const b = acquire(ctx, "worker-2");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("busy");
    ctx.db.close();
  });

  /**
   * **F4 の土台。** 別商品が同じロールを与えると、purchase 単位の claim は
   * 両方に live を許す。だから鍵が要る。
   */
  it("別購入・同じ (user, role) でも、投げてよいのは1人だけ", () => {
    const ctx = setup();
    const A = buy(ctx, ctx.mk("庭園・月額券").id);
    const B = buy(ctx, ctx.mk("庭園・特別券").id);

    // 前提: purchase 単位の claim は**両方**取れてしまう
    expect(ctx.shop.claimExternalDelivery({ purchaseId: A.id, deliveryKind: "add_role", actor: "w1" }).ok).toBe(true);
    expect(ctx.shop.claimExternalDelivery({ purchaseId: B.id, deliveryKind: "add_role", actor: "w2" }).ok).toBe(true);

    // 外部効果の鍵は1人だけ
    expect(acquire(ctx, "w1", A.id).ok).toBe(true);
    expect(acquire(ctx, "w2", B.id).ok).toBe(false);
    ctx.db.close();
  });

  it("キーが違えば互いに干渉しない", () => {
    const ctx = setup();
    expect(acquire(ctx, "w1").ok).toBe(true);
    const other = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role_add",
      key: Shop.discordRoleAddEffectKey(GUILD, USER, "r-other"),
      owner: "w2",
    });
    expect(other.ok).toBe(true);
    const otherUser = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role_add",
      key: Shop.discordRoleAddEffectKey(GUILD, "u-other", ROLE),
      owner: "w3",
    });
    expect(otherUser.ok).toBe(true);
    ctx.db.close();
  });

  it("キーは guild / user / role をすべて含む", () => {
    expect(Shop.discordRoleAddEffectKey("g1", "u1", "r1")).not.toBe(Shop.discordRoleAddEffectKey("g2", "u1", "r1"));
    expect(Shop.discordRoleAddEffectKey("g1", "u1", "r1")).not.toBe(Shop.discordRoleAddEffectKey("g1", "u2", "r1"));
    expect(Shop.discordRoleAddEffectKey("g1", "u1", "r1")).not.toBe(Shop.discordRoleAddEffectKey("g1", "u1", "r2"));
  });

  it("DBの索引が最後の砦になっている", () => {
    const ctx = setup();
    acquire(ctx, "w1");
    // 索引を迂回して2つ目の live 行を作ろうとすると DB が拒む
    expect(() =>
      ctx.db
        .prepare(
          `INSERT INTO shop_external_effect_locks
             (effect_scope, effect_key, owner_token, owner, purchase_id, state, detail, acquired_at, updated_at)
           VALUES ('discord_role_add', ?, 'forged', 'attacker', NULL, 'held', NULL, 1, 1)`,
        )
        .run(KEY),
    ).toThrow(/UNIQUE/i);
    ctx.db.close();
  });
});

// ── F3 同時取得 ──────────────────────────────────────────────────────────────

describe("F3: 同時に取りにいっても勝者は1人", () => {
  it("10並列で取得しても held は1つ", () => {
    const ctx = setup();
    const results = Array.from({ length: 10 }, (_, i) => acquire(ctx, `worker-${i}`));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_external_effect_locks WHERE state='held'").pluck().get(),
    ).toBe(1);
    ctx.db.close();
  });
});

// ── F11 stale token ──────────────────────────────────────────────────────────

describe("F11: 他人の鍵は動かせない", () => {
  it("違うトークンでは settle / release / uncertain のどれもできない", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const bad = { key: KEY, token: "not-my-token", reason: "x", actor: "attacker" };
    expect(ctx.shop.settleExternalEffectLock(bad)).toBe(false);
    expect(ctx.shop.releaseExternalEffectLock(bad)).toBe(false);
    expect(ctx.shop.markExternalEffectUncertain(bad)).toBe(false);

    // 所有者は変わっていない
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("worker-1");
    // 正しいトークンなら動く
    expect(ctx.shop.releaseExternalEffectLock({ key: KEY, token: a.token, reason: "done", actor: "worker-1" })).toBe(true);
    ctx.db.close();
  });

  it("解放されるまで次の worker は取れない", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    if (!a.ok) return;
    expect(acquire(ctx, "worker-2").ok).toBe(false);
    ctx.shop.releaseExternalEffectLock({ key: KEY, token: a.token, reason: "done", actor: "worker-1" });
    expect(acquire(ctx, "worker-2").ok).toBe(true);
    ctx.db.close();
  });
});

// ── F5 / F6 / F7 crash・uncertain ────────────────────────────────────────────

describe("落ちたとき・分からないとき", () => {
  it("F5: 効果を投げる前に落ちても、鍵は残り外部効果は0", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    expect(a.ok).toBe(true);
    // プロセスが落ちた＝何も transition しないまま
    const open = ctx.shop.listUnresolvedExternalEffectLocks();
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("held");
    // 再起動後も別 worker は取れない（＝重ねて投げない）
    expect(acquire(ctx, "worker-2").ok).toBe(false);
    ctx.db.close();
  });

  it("F6: 結果が分からないときは解放しない", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "final_fetch_failed", actor: "w1" });

    // **`uncertain` は live のまま。** 「たぶん失敗」で次の worker に投げさせない
    expect(ctx.shop.externalEffectLockHolder(KEY)?.state).toBe("uncertain");
    expect(acquire(ctx, "worker-2").ok).toBe(false);
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(1);
    ctx.db.close();
  });

  it("F7: 効果のあとに落ちても、鍵が残るので二度目は投げられない", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    expect(a.ok).toBe(true);
    // roles.add は成功したが、DBへ書く前に落ちた
    expect(acquire(ctx, "worker-2").ok).toBe(false);
    // 収束は Discord の実状態を見てから決める（ここでは鍵が残っていることだけ）
    expect(ctx.shop.listUnresolvedExternalEffectLocks()[0]!.state).toBe("held");
    ctx.db.close();
  });

  it("収束できたら次の worker が取れる", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    if (!a.ok) return;
    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "unknown", actor: "w1" });
    // 実状態を確認して閉じる
    expect(
      ctx.shop.settleExternalEffectLock({ key: KEY, token: a.token, reason: "recovered_role_present", actor: "sys" }),
    ).toBe(true);
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(0);
    expect(acquire(ctx, "worker-2").ok).toBe(true);
    ctx.db.close();
  });

  it("履歴は消えない（append-only）", () => {
    const ctx = setup();
    const a = acquire(ctx, "worker-1");
    if (!a.ok) return;
    ctx.shop.releaseExternalEffectLock({ key: KEY, token: a.token, reason: "done", actor: "w1" });
    expect(() => ctx.db.prepare("DELETE FROM shop_external_effect_locks").run()).toThrow(/append-only/);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_external_effect_locks").pluck().get()).toBe(1);
    ctx.db.close();
  });
});

// ── §13 鍵は配送済みの authority ではない ────────────────────────────────────

describe("鍵は「提供された」の証拠ではない", () => {
  it("取っても・返しても・分からなくても、提供済みにはならない", () => {
    const ctx = setup();
    const p = buy(ctx, ctx.mk("庭園").id);
    const before = ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence;

    const a = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role_add", key: KEY, owner: "w1", purchaseId: p.id,
    });
    if (!a.ok) return;
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(before);

    ctx.shop.markExternalEffectUncertain({ key: KEY, token: a.token, reason: "?", actor: "w1" });
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(before);

    ctx.shop.settleExternalEffectLock({ key: KEY, token: a.token, reason: "ok", actor: "w1" });
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(before);
    expect(ctx.shop.verifiedDeliveryEvidence(p.id)).toHaveLength(0);
    expect(ctx.shop.getPurchase(p.id)!.delivered_at).toBeNull();
    ctx.db.close();
  });

  it("鍵の履歴は購入から辿れる（監査用）", () => {
    const ctx = setup();
    const p = buy(ctx, ctx.mk("庭園").id);
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role_add", key: KEY, owner: "w1", purchaseId: p.id });
    const rows = ctx.shop.externalEffectLocksForPurchase(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect_key: KEY, owner: "w1", state: "held", purchase_id: p.id });
    ctx.db.close();
  });
});

// ── F9 / F10 失効・返金との関係 ──────────────────────────────────────────────

describe("F9 / F10: 失効・返金は鍵に勝手を許さない", () => {
  it("F10: 鍵を持っていても、purchase claim が守るものは変わらない", () => {
    const ctx = setup();
    const p = buy(ctx, ctx.mk("庭園").id);
    // 通常配送が purchase claim を取り、外部効果の鍵も取った
    const claim = ctx.shop.claimExternalDelivery({ purchaseId: p.id, deliveryKind: "add_role", actor: "w1" });
    expect(claim.ok).toBe(true);
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role_add", key: KEY, owner: "w1", purchaseId: p.id });

    // 投げている最中の返金は従来どおり止まる（authority は claim 側）
    expect(() => ctx.shop.refund(p.id, "いま返金", "staff")).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );
    ctx.db.close();
  });

  it("F9: 鍵は失効の判断を書き換えない", () => {
    const ctx = setup();
    const item = ctx.mk("庭園");
    const p = buy(ctx, item.id);
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role_add", key: KEY, owner: "w1", purchaseId: p.id });
    ctx.db.prepare("UPDATE shop_items SET kind='one_shot' WHERE id=?").run(item.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);

    // 失効の可否は既存の authority（claim / 返金の決着）が決める。鍵は関与しない
    const blocked = ctx.shop.expiryBlockedBy(p.id);
    expect(blocked === null || blocked === "delivery_in_flight" || blocked === "refund_pending").toBe(true);
    ctx.db.close();
  });
});
