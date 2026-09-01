import { Collection, type Guild, type GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForGuild } from "../src/timed-access.js";
import type { Services } from "../src/services.js";

/**
 * **正本は「鍵を取ったあとに見た状態」。取る前に見た状態ではない。**
 *
 * 候補はDBから来るので、Discord を最初に読むのは鍵を取ったあと——という順序が
 * 守られていないと、取得を待っている間に外部が変わった場合に古い観測で動く。
 * ロールが既に付いているのに、もう一度 `roles.add` を投げることになる。
 *
 * ここでは**取得の境界で外部状態を変える**。順序が正しければ変化後を見るので
 * 何も投げない。順序が逆なら変化前の観測で投げてしまう。時間待ちは使わない。
 *
 * 重要: fetch ごとに**その時点のスナップショット**を返す。1つの可変 Set を
 * 共有すると、取得前に取った member まで後から「ロールが付いている」ことに
 * なってしまい、古い観測という状況自体が作れない。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const USER = "1463201396567441441";
const ROLE = "r-vip";
const GUILD = "main-guild";
const KEY = Shop.discordRoleEffectKey(GUILD, USER, ROLE);

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY, to: `user:${USER}`, amount: 1_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:order",
  });
  const item = shop.createItem(
    {
      name: "庭園", price_land: 100, kind: "monthly", duration_days: 30,
      delivery: "auto", delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    "staff",
  );
  const purchaseId = db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
       VALUES (?,?,1,?,100,'active','delivered',?) RETURNING id`,
    )
    .pluck()
    .get(
      item.id,
      USER,
      Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
    ) as number;
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? GUILD : undefined)) };
  const services = { db, ledger, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, item, purchaseId, services };
}
type Ctx = ReturnType<typeof setup>;

/**
 * **fetch ごとに別のスナップショットを返す Discord。**
 *
 * 権威ある状態は `authoritative` が1つだけ持ち、`fetch` はその時点の内容を
 * 固めた member を返す。取得前に取った member は、あとで外部が変わっても
 * **変わらない**——これが「古い観測」を再現するための要。
 */
function snapshotDiscord(initial: string[] = []) {
  const authoritative = new Set<string>(initial);
  const trace: string[] = [];
  const add = vi.fn(async (id: string) => {
    trace.push("add");
    authoritative.add(id);
  });
  const remove = vi.fn(async (id: string) => void authoritative.delete(id));
  const snapshot = (): GuildMember => {
    const frozen = new Set(authoritative); // ← この瞬間の写し
    return {
      id: USER,
      roles: {
        cache: Object.assign(new Collection<string, { id: string }>(), { has: (id: string) => frozen.has(id) }),
        add,
        remove,
      },
    } as unknown as GuildMember;
  };
  const fetch = vi.fn(async () => {
    trace.push("fetch");
    return snapshot();
  });
  const guild = { id: GUILD, members: { fetch } } as unknown as Guild;
  return { guild, add, remove, fetch, trace, authoritative, becomePresent: () => authoritative.add(ROLE) };
}

describe("観測の順序: 鍵を取ったあとに見た状態が正本", () => {
  /**
   * **M6' を殺すためのテスト。**
   *
   * 取得の境界で外部が「ロールあり」へ変わる。正しい順序なら、取得後の観測が
   * それを捉えるので何も投げない。取得前の観測で動くと、古い「ロールなし」を
   * 信じて `roles.add` を投げてしまう。
   */
  it("取得の境界で外部が変わったら、変化後を見て何も投げない", async () => {
    const ctx = setup();
    const d = snapshotDiscord([]); // 最初はロールなし＝復元したい候補

    // 鍵の取得そのものを境界にする。取得が済んだ瞬間に外部が変わる
    const realAcquire = ctx.shop.acquireExternalEffectLock.bind(ctx.shop);
    const acquireSpy = vi
      .spyOn(ctx.shop, "acquireExternalEffectLock")
      .mockImplementation((input) => {
        d.trace.push("acquire");
        const result = realAcquire(input);
        d.becomePresent(); // ← 取得の直後に外部がロールを得た
        return result;
      });

    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    // **本命の振る舞い。** 変化後を見ているので投げない
    expect(d.add).not.toHaveBeenCalled();
    // 起源を証明していないので提供済みにもしない（Task #213）
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_verified_delivery_evidence").pluck().get(),
    ).toBe(0);
    expect(ctx.shop.safetySnapshot(ctx.purchaseId)!.fulfillment.verifiedExternal).toBe(false);
    // 鍵は握りっぱなしにしない
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    expect(ctx.shop.safetySnapshot(ctx.purchaseId)!.contradictions).toEqual([]);

    // 前提が本当に成立していたか（副次的な確認）
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(d.authoritative.has(ROLE)).toBe(true); // 外部は確かに変化した
    // 候補の絞り込みの観測は取得より前に来るが、**権威ある観測は取得より後**。
    // 見るべきは最後の fetch（＝実際に判断へ使ったもの）が acquire より後にあること
    expect(d.trace.lastIndexOf("fetch")).toBeGreaterThan(d.trace.indexOf("acquire"));
    // 絞り込み → 取得 → 権威ある観測、の3段になっている
    expect(d.trace.indexOf("fetch")).toBeLessThan(d.trace.indexOf("acquire"));
    acquireSpy.mockRestore();
    ctx.db.close();
  });

  it("古い観測を持っていても、正本は取得後の観測", async () => {
    const ctx = setup();
    const d = snapshotDiscord([]);

    // 取得前に誰かが同じ member を読んでいた（＝古い写し）
    const stale = await d.guild.members.fetch({ user: USER, force: true });
    expect(stale.roles.cache.has(ROLE)).toBe(false);

    const realAcquire = ctx.shop.acquireExternalEffectLock.bind(ctx.shop);
    const spy = vi.spyOn(ctx.shop, "acquireExternalEffectLock").mockImplementation((input) => {
      const r = realAcquire(input);
      d.becomePresent();
      return r;
    });

    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    // **古い写しは古いまま**（共有 Set にしていないことの確認）
    expect(stale.roles.cache.has(ROLE)).toBe(false);
    // それでも巡回は投げない＝古い写しで動いていない
    expect(d.add).not.toHaveBeenCalled();
    spy.mockRestore();
    ctx.db.close();
  });

  it("外部が変わらなければ、取得後の観測どおり普通に復元する", async () => {
    const ctx = setup();
    const d = snapshotDiscord([]); // 最後までロールなし

    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    // こちらは投げる。上のテストが「常に投げない」で通っていないことの担保
    expect(d.add).toHaveBeenCalledTimes(1);
    expect(d.authoritative.has(ROLE)).toBe(true);
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    ctx.db.close();
  });
});
