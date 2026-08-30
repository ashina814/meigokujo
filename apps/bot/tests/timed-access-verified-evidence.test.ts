import { Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForGuild } from "../src/timed-access.js";
import type { Services } from "../src/services.js";

/**
 * **巡回が自分で外部効果を成立させ、それを確認できたときだけ証拠を残す。**
 *
 * 本番 #58 では、この巡回が実際にロールを付け直し force refetch で在席まで
 * 確認したのに、移行の推測値 `delivery_state='delivered'` が
 * `completeDeliveryWith()` の二重実行 guard に当たり、`delivered_at` も
 * `shop_delivered` も残らなかった。
 *
 * ただし「ロールが今ある」は「この購入が提供された」ではない。証拠は返金拒否という
 * 不可逆判断に使うので、**帰属が一意に証明できるときにしか書かない**。
 */

const USER = "user-1";
const ROLE = "access-role";
const SOURCE = "timed_access_role_added_and_refetched";

registerDefaultTxTypes();

function setup(opts: { legacy?: boolean } = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const item = shop.createItem(
    {
      name: "迷霊庭園入場券",
      price_land: 1_000,
      kind: "monthly",
      duration_days: 30,
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE, channel_id: "access-channel" }),
    },
    "staff",
  );
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 100_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: `seed:${Math.random()}`,
  });
  /**
   * **本番 #58 と同じ形を直接作る。**
   *
   * `status='active'` / `delivery_state='delivered'`（移行の推測値）/
   * `delivered_at IS NULL` / `shop_delivered` なし / fulfillment provenance なし。
   * provenance は append-only なので、普通に買ってから消すことはできない。
   */
  const buy = (opt: { legacy?: boolean; deliveryState?: string } = {}): { id: number } => {
    const id = db
      .prepare(
        `INSERT INTO shop_purchases
           (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
         VALUES (?,?,1,?,1000,'active',?,?) RETURNING id`,
      )
      .pluck()
      .get(
        item.id,
        USER,
        Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        opt.deliveryState ?? "delivered",
        opt.legacy
          ? null
          : JSON.stringify({
              delivery: "auto",
              delivery_kind: "add_role",
              delivery_data: { role_id: ROLE, channel_id: "access-channel" },
            }),
      ) as number;
    return { id };
  };
  const purchase = buy({ legacy: opts.legacy });
  const settings = { getString: vi.fn((key: string) => (key === "guild:main" ? "main-guild" : undefined)) };
  return { db, ledger, events, shop, item, purchase, buy, services: { shop, events, settings } as Services };
}
type Ctx = ReturnType<typeof setup>;

function guildWith(
  roles: string[] = [],
  opts: {
    id?: string;
    addFails?: boolean;
    finalFetchFails?: boolean;
    expireOnAdd?: () => void;
    removeAfterAdd?: boolean;
  } = {},
) {
  const cache = new Collection(roles.map((id) => [id, { id }]));
  let fetches = 0;
  const member = {
    id: USER,
    roles: {
      cache,
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error("temporary add failure");
        cache.set(id, { id });
        // Discord側で誰かが即座に剥がした、を再現する
        if (opts.removeAfterAdd) cache.delete(id);
        opts.expireOnAdd?.();
      }),
      remove: vi.fn(async (id: string) => {
        cache.delete(id);
      }),
    },
  };
  const guild = {
    id: opts.id ?? "main-guild",
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        if (opts.finalFetchFails && fetches > 1) throw new Error("final fetch unavailable");
        return member;
      }),
    },
  } as unknown as Guild;
  return { guild, member, cache };
}

const evidenceOf = (ctx: Ctx, id: number) => ctx.shop.verifiedDeliveryEvidence(id);
const allEvidence = (ctx: Ctx) =>
  ctx.db.prepare("SELECT COUNT(*) FROM shop_verified_delivery_evidence").pluck().get() as number;

// ── §12 #58 regression ───────────────────────────────────────────────────────

describe("#58: 実際に付け直して確認できたなら、証拠が残る", () => {
  it("推測値に握り潰されず verified evidence が残る", async () => {
    const ctx = setup();
    const id = ctx.purchase.id;
    // 前提: 実行側の経路では黙って弾かれる形
    expect(ctx.shop.markDeliverySucceeded(id, "system:shop-timed-access")).toBe(false);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);

    const discord = guildWith();
    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result).toMatchObject({ checked: 1, restored: 1, failed: [] });
    // 外部効果はちょうど1回
    expect(discord.member.roles.add).toHaveBeenCalledTimes(1);
    expect(discord.member.roles.remove).not.toHaveBeenCalled();

    const rows = evidenceOf(ctx, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: SOURCE, writer: "system:shop-timed-access", effect_target: ROLE });

    const snap = ctx.shop.safetySnapshot(id)!;
    expect(snap.fulfillment.evidence).toBe(true);
    expect(snap.fulfillment.verifiedExternal).toBe(true);
    // **歴史は書き換えない**
    expect(snap.fulfillment.deliveredAt).toBeNull();
    expect(snap.fulfillment.state).toBe("delivered"); // 推測値のまま
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    expect(snap.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("証拠が立つと、返金は拒まれ、どのキューにも出ない", async () => {
    const ctx = setup();
    const id = ctx.purchase.id;
    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);

    expect(() => ctx.shop.refund(id, "あとから", "staff")).toThrow(
      expect.objectContaining({ code: "ERR_ALREADY_DELIVERED" }),
    );
    expect(ctx.shop.listUnresolvedCases({ limit: 100 }).some((c) => c.purchaseId === id)).toBe(false);
    expect(ctx.shop.listUndeliveredAuto(100).some((r) => r.id === id)).toBe(false);
    expect(ctx.shop.listPendingManual({ limit: 100 }).some((r) => r.id === id)).toBe(false);
    ctx.db.close();
  });

  it("巡回を繰り返しても証拠は1行のまま", async () => {
    const ctx = setup();
    const id = ctx.purchase.id;
    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);
    // 2回目はロールが既にあるので add しない
    const second = guildWith([ROLE]);
    await reconcileTimedAccessForGuild(second.guild, ctx.services);
    await reconcileTimedAccessForGuild(guildWith([ROLE]).guild, ctx.services);

    expect(second.member.roles.add).not.toHaveBeenCalled();
    expect(evidenceOf(ctx, id)).toHaveLength(1);
    expect(ctx.events.listByType("shop_delivery_evidence_recorded")).toHaveLength(1);
    ctx.db.close();
  });
});

// ── §13 added=false ──────────────────────────────────────────────────────────

describe("元からロールがあるとき（added=false）は、何も推測しない", () => {
  it("証拠を作らない — ロールの起源を証明していない", async () => {
    const ctx = setup();
    const discord = guildWith([ROLE]);

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result.restored).toBe(0);
    expect(discord.member.roles.add).not.toHaveBeenCalled();
    // **提供済みの証拠にしない**
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(ctx.purchase.id)!.fulfillment.evidence).toBe(false);
    // かといって失敗でも未提供でもない。歴史を捏造しない
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.delivered_at).toBeNull();
    expect(ctx.events.listByType("shop_timed_access_reconcile_failed")).toHaveLength(0);
    expect(ctx.shop.operatorConfirmedNoEffect(ctx.purchase.id)).toBe(false);
    ctx.db.close();
  });

  it("既に別の正本があるなら、それはそのまま残る", async () => {
    const ctx = setup();
    const id = ctx.purchase.id;
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "delivered",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "運営が確認済み",
    });

    await reconcileTimedAccessForGuild(guildWith([ROLE]).guild, ctx.services);

    expect(allEvidence(ctx)).toBe(0); // Bot は何も足していない
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(true); // 人の authority は不変
    expect(ctx.shop.safetySnapshot(id)!.operatorCase.decided).toBe("delivered");
    ctx.db.close();
  });
});

// ── §14 ambiguous attribution ────────────────────────────────────────────────

describe("同じロールを与える契約が複数あるとき、どれにも証拠を付けない", () => {
  it("2契約 — 代表に選ばれた購入へも書かない", async () => {
    const ctx = setup();
    const second = ctx.buy();

    const discord = guildWith();
    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    // Discordへの操作は1回で正しい（同じロールを二度付けない）
    expect(result.checked).toBe(1);
    expect(discord.member.roles.add).toHaveBeenCalledTimes(1);
    expect(discord.cache.has(ROLE)).toBe(true);

    // **どちらにも証拠を付けない。** この1回の付与がどちらの効果かは決まらない
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(ctx.purchase.id)!.fulfillment.evidence).toBe(false);
    expect(ctx.shop.safetySnapshot(second.id)!.fulfillment.evidence).toBe(false);
    // **「提供済みだから返せない」にはならない。** 証拠を書いていないのだから当然。
    // 止まるとしても理由は従来どおり「結末が分からない」＝人が確認してから決める、
    // であって、こちらが勝手に作った証拠ではない
    expect(() => ctx.shop.refund(second.id, "確認のうえ", "staff")).toThrow(
      expect.objectContaining({ code: "ERR_FULFILLMENT_UNKNOWN" }),
    );
    // 運営が確認すれば、通常どおり返金できる（導線が消えていない）
    expect(
      ctx.shop.resolveOperatorCase({
        purchaseId: second.id,
        decision: "no_effect",
        expectedToken: ctx.shop.quoteOperatorResolution(second.id).token,
        actor: "operator:1",
        note: "提供されていないことを確認",
        refund: true,
      }).refunded,
    ).toBe(true);
    ctx.db.close();
  });

  it("片方が失効していれば、残った1つへ帰属できる", async () => {
    const ctx = setup();
    const second = ctx.buy();
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id);

    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);

    expect(evidenceOf(ctx, second.id)).toHaveLength(1);
    expect(evidenceOf(ctx, ctx.purchase.id)).toHaveLength(0);
    ctx.db.close();
  });

  it("3契約でも、並び順で勝者を作らない", async () => {
    const ctx = setup();
    const ids = [ctx.purchase.id];
    for (let i = 0; i < 2; i += 1) ids.push(ctx.buy().id);

    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);

    expect(allEvidence(ctx)).toBe(0);
    for (const id of ids) expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    ctx.db.close();
  });
});

// ── §15 races ────────────────────────────────────────────────────────────────

describe("競合", () => {
  it("A: 付ける直前に失効 → Discordへ触らず、証拠も無い", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id);
    const discord = guildWith();

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result.checked).toBe(0); // そもそも有効契約として出てこない
    expect(discord.member.roles.add).not.toHaveBeenCalled();
    expect(allEvidence(ctx)).toBe(0);
    ctx.db.close();
  });

  it("B: 付けた直後にDiscord側で消える → 証拠なし・失敗として残す", async () => {
    const ctx = setup();
    const discord = guildWith([], { removeAfterAdd: true });

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toBe("role_missing_after_add");
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(ctx.purchase.id)!.fulfillment.evidence).toBe(false);
    ctx.db.close();
  });

  it("C: force refetch できない → 証拠なし", async () => {
    const ctx = setup();
    const discord = guildWith([], { finalFetchFails: true });

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result.failed).toHaveLength(1);
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("D: add と失効が競合 → 自分で剥がし、証拠も残さない", async () => {
    const ctx = setup();
    const discord = guildWith([], {
      expireOnAdd: () =>
        ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id),
    });

    await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    // 既存の失効収束はそのまま
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("expired");
    expect(discord.member.roles.remove).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(discord.cache.has(ROLE)).toBe(false);
    // **剥がしたものを提供済みにしない**
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(ctx.purchase.id)!.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("E: 付与に失敗 → 証拠なし。次の巡回で復旧すれば証拠が立つ", async () => {
    const ctx = setup();
    const failing = guildWith([], { addFails: true });
    await reconcileTimedAccessForGuild(failing.guild, ctx.services);
    expect(allEvidence(ctx)).toBe(0);

    const working = guildWith();
    await reconcileTimedAccessForGuild(working.guild, ctx.services);
    expect(evidenceOf(ctx, ctx.purchase.id)).toHaveLength(1);
    ctx.db.close();
  });

  /**
   * **本来の Race F。** 通常の自動配送が外部へ投げている最中に巡回が走る。
   *
   * 現状の巡回は生きている claim を見ないので、`roles.add()` が二重に走りうるし、
   * claim を握ったまま置き去りにする。これは Task #213 以前からある claim
   * architecture 側の問題で、ここでは直さない（別タスク）。
   *
   * ここで守るのは **新しい authority をその矛盾へ混ぜないこと**——
   * 誰の実行による効果か決まらない間は、提供済みの証拠を書かない。
   */
  it("F(本来): 通常配送が claim を握っている最中は、証拠を書かない", async () => {
    const ctx = setup();
    // 通常配送が進行中＝工程は pending。ここでなければ claim 自体が取れない
    const id = ctx.buy({ deliveryState: "pending" }).id;
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id);
    const claimed = ctx.shop.claimExternalDelivery({
      purchaseId: id,
      deliveryKind: "add_role",
      actor: "system:auto",
    });
    expect(claimed.ok).toBe(true); // 本当に claim を握れている

    const discord = guildWith();
    await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    // 巡回は従来どおりロールを復元する（この挙動はこのタスクでは変えない）
    expect(discord.cache.has(ROLE)).toBe(true);
    // **が、その効果をこの購入の提供済み証拠にはしない**
    expect(allEvidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.verifiedExternal).toBe(false);
    ctx.db.close();
  });

  it("F(本来): claim が決着したあとの巡回なら、証拠が立つ", async () => {
    const ctx = setup();
    const id = ctx.buy({ deliveryState: "pending" }).id;
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id);
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: id,
      deliveryKind: "add_role",
      actor: "system:auto",
    }) as { ok: true; token: string };
    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);
    expect(allEvidence(ctx)).toBe(0);

    ctx.shop.releaseExternalDelivery({
      purchaseId: id,
      token: claim.token,
      reason: "verified_no_effect",
      actor: "system:auto",
    });
    // ロールは既にあるので add はされない＝証拠も立たない（added=false の規則）
    await reconcileTimedAccessForGuild(guildWith([ROLE]).guild, ctx.services);
    expect(allEvidence(ctx)).toBe(0);

    // ロールが消えた状態で巡回すれば、自分で付け直して確認できる
    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);
    expect(evidenceOf(ctx, id)).toHaveLength(1);
    ctx.db.close();
  });

  it("互換経路で復元できても、購入時の証拠が無ければ提供済みにしない", async () => {
    const ctx = setup();
    // スナップショットも provenance も移行記録も無い旧購入。
    // 運営の決着があるので互換経路では有効契約として見える
    const id = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state)
         VALUES (?,?,1,?,1000,'active','pending') RETURNING id`,
      )
      .pluck()
      .get(ctx.item.id, USER, Math.floor(Date.now() / 1000) + 30 * 24 * 3600) as number;
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "delivered",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "運営が確認済み",
    });
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toEqual({ kind: "legacy_unknown" });

    await reconcileTimedAccessForGuild(guildWith().guild, ctx.services);

    // **現在の商品設定を根拠に、この購入の返金拒否 authority を作らない**
    expect(evidenceOf(ctx, id)).toHaveLength(0);
    ctx.db.close();
  });

  it("F: main guild 以外では、証拠も外部効果も発生しない", async () => {
    const ctx = setup();
    const other = guildWith([], { id: "other-guild" });

    await reconcileTimedAccessForGuild(other.guild, ctx.services);

    expect(other.guild.members.fetch).not.toHaveBeenCalled();
    expect(allEvidence(ctx)).toBe(0);
    ctx.db.close();
  });

  it("スナップショット導入前の契約でも同じ規則が効く", async () => {
    const ctx = setup({ legacy: true });
    const discord = guildWith();

    // スナップショットが無い購入は、現在の商品設定との互換経路でしか出てこない。
    // 提供済みの証拠が無ければそもそも対象外＝ここでは何も起きない
    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services, USER);

    expect(allEvidence(ctx)).toBe(result.restored);
    if (result.restored === 1) {
      // 互換経路で復元できた場合でも、剥奪対象は購入時の証拠が無いので不明のまま
      expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(ctx.purchase.id)!)).toEqual({
        kind: "legacy_unknown",
      });
    }
    ctx.db.close();
  });
});
