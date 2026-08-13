import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import {
  EventLog,
  Ledger,
  OriginalRoles,
  Settings,
  Shop,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * オリジナルロールの導線。
 *
 * - 申請では **Land を動かさない**
 * - 支払いは承認のあとだけ
 * - 作成に失敗したら自動返金し、**付けられないロールを残さない**
 * - 更新はスタッフを介さない
 * - 期限3日前に知らせ、期限切れで剥奪する
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const jobsModule = import("../src/original-role-jobs.js");

const USER = "1463201396567441441";
const PRICE = 750_000;
const RENEW = 250_000;
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const originalRoles = new OriginalRoles(db, ledger, events);
  const item = shop.createItem(
    { name: "オリジナルロール新規作成", price_land: PRICE, kind: "one_shot", delivery: "auto", delivery_kind: "create_original_role" },
    "staff",
  );
  settings.set("guild:main", "g1", "staff");
  settings.set("shop:original_role_item_id", String(item.id), "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  const services = { db, ledger, settings, events, shop, originalRoles } as unknown as Services;
  return { db, ledger, settings, events, shop, originalRoles, item, services };
}

type Ctx = ReturnType<typeof setup>;
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

/** ロール作成の成否を差し込めるギルド */
function world(
  opts: {
    createFails?: string;
    addFails?: string;
    /** エラーを返すが、Discord側では付与が通っていた（外部APIではよくある） */
    addActuallyApplies?: boolean;
    removeFails?: boolean;
    /** エラーを返すが、Discord側では剥奪が通っていた */
    removeActuallyApplies?: boolean;
    fetchFails?: boolean;
    notRemovable?: boolean;
  } = {},
) {
  const roleDeleted: string[] = [];
  const memberRoles: string[] = [];
  const memberRoleCache = new Collection<string, unknown>();
  const member = {
    id: USER,
    roles: {
      cache: memberRoleCache,
      add: vi.fn(async (id: string) => {
        if (opts.addFails) {
          if (opts.addActuallyApplies) {
            memberRoles.push(id);
            memberRoleCache.set(id, true);
          }
          throw new Error(opts.addFails);
        }
        memberRoles.push(id);
        memberRoleCache.set(id, true);
      }),
      remove: vi.fn(async (id: string) => {
        const drop = () => {
          const i = memberRoles.indexOf(id);
          if (i >= 0) memberRoles.splice(i, 1);
          memberRoleCache.delete(id);
        };
        if (opts.removeFails) {
          if (opts.removeActuallyApplies) drop();
          throw new Error("Service Unavailable");
        }
        drop();
      }),
    },
  };
  let seq = 0;
  // 作られたロールはギルドに残る。**クラッシュ後の再試行がこれを見つけられるか**が要点
  const living = new Collection<string, ReturnType<typeof makeRole>>();
  const makeRole = (name: string) => {
    const id = `role-${++seq}`;
    const role = {
      id,
      name,
      managed: false,
      editable: !opts.notRemovable,
      edit: vi.fn(async (o: { name?: string }) => {
        if (o.name) role.name = o.name;
        return role;
      }),
      delete: vi.fn(async () => {
        roleDeleted.push(id);
        living.delete(id);
      }),
    };
    living.set(id, role);
    return role;
  };
  const guild = {
    id: "g1",
    roles: {
      create: vi.fn(async (o: { name: string }) => {
        if (opts.createFails) throw new Error(opts.createFails);
        return makeRole(o.name);
      }),
      fetch: vi.fn(async (id?: string) => {
        // **一覧が読めない**状況（APIの失敗）。これを「無い」と混同しない
        if (opts.fetchFails) throw new Error("Service Unavailable");
        return id === undefined ? living : (living.get(id) ?? null);
      }),
      cache: living,
    },
    // force fetch でも同じ member を返す（cache が実物の代わり）
    members: { fetch: vi.fn(async () => member) },
  };
  return { guild, member, memberRoles, roleDeleted, living, makeRole };
}

function press(ctx: Ctx, customId: string, w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  return {
    customId,
    id: `int-${Math.random()}`,
    user: { id: USER },
    guild: w.guild,
    member: w.member,
    client: { channels: { fetch: vi.fn(async () => null) }, users: { fetch: vi.fn(async () => null) } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    ...extra,
  } as never;
}

const contentOf = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0]?.content ?? "");

describe("申請", () => {
  it("**申請では Land を動かさない**", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world();
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "冥き翼" : "#A855F7") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    const rows = ctx.originalRoles.listByUser(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.color).toBe(0xa855f7);
    expect(contentOf(m.reply)).toContain("課金していません");
    ctx.db.close();
  });

  it("色の書式が違えば申請を作らない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, world(), {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "あ" : "むらさき") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("16進数");
    ctx.db.close();
  });

  it("進行中の申請があれば重ねて出せない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    ctx.originalRoles.apply({ userId: USER, name: "さき", color: null, actor: "t" });
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, world(), {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "あと" : "") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(1);
    expect(contentOf(m.reply)).toContain("進行中");
    ctx.db.close();
  });
});

describe("承認後の支払いと作成", () => {
  function approved(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: 0xa855f7, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    return row;
  }

  it("支払うとロールが作られ、付与され、30日の契約が始まる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w), ctx.services);

    expect(w.guild.roles.create).toHaveBeenCalled();
    expect(w.memberRoles).toHaveLength(1);
    const after = ctx.originalRoles.get(row.id)!;
    expect(after.status).toBe("active");
    expect(after.role_id).toBe("role-1");
    expect(after.expires_at! - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * DAY);
    expect(balance(ctx)).toBe(5_000_000 - PRICE);
    ctx.db.close();
  });

  it("**危険な権限を付けない**（権限は空・メンション不可・一覧分けなし）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w), ctx.services);

    const opts = (w.guild.roles.create.mock.calls[0] as never[])[0] as {
      permissions: unknown[];
      mentionable: boolean;
      hoist: boolean;
    };
    expect(opts.permissions).toEqual([]);
    expect(opts.mentionable).toBe(false);
    expect(opts.hoist).toBe(false);
    ctx.db.close();
  });

  it("承認前は支払えない（課金しない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = ctx.originalRoles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w), ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(w.guild.roles.create).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it("**作成に失敗したら自動返金する**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ createFails: "Missing Permissions" });

    const p = press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };
    await handleShopButton(p as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved"); // 契約は始まっていない
    expect(contentOf(p.editReply)).toContain("返金");
    ctx.db.close();
  });

  it("**付与に失敗したら作ったロールを残さない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ addFails: "Missing Permissions" });

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w), ctx.services);

    expect(w.roleDeleted).toEqual(["role-1"]); // 誰のものでもないロールを残さない
    expect(balance(ctx)).toBe(5_000_000); // 返金済み
    ctx.db.close();
  });

  it("二度押しても二重課金せず、ロールも1つだけ", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const id = `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`;

    await handleShopButton(press(ctx, id, w), ctx.services);
    await handleShopButton(press(ctx, id, w), ctx.services);

    expect(balance(ctx)).toBe(5_000_000 - PRICE);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(w.guild.roles.create).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });
});

describe("更新（スタッフを介さない）", () => {
  function active(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.originalRoles.activate({ id: row.id, roleId: "role-1", purchaseId: 1, actor: "t" });
    return ctx.originalRoles.get(row.id)!;
  }

  it("確認した料金で更新でき、期限が+30日になる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);

    await handleShopButton(
      press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()),
      ctx.services,
    );

    expect(balance(ctx)).toBe(5_000_000 - RENEW);
    expect(ctx.originalRoles.get(row.id)!.expires_at! - row.expires_at!).toBe(30 * DAY);
    ctx.db.close();
  });

  it("**確認後に料金が変わったら課金しない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);
    ctx.settings.set("original_role_renew_price", 300_000, "staff");

    const p = press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()) as unknown as {
      update: ReturnType<typeof vi.fn>;
    };
    await handleShopButton(p as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.originalRoles.get(row.id)!.expires_at).toBe(row.expires_at);
    expect(contentOf(p.update)).toContain("引き落としていません");
    ctx.db.close();
  });

  it("他人の契約は更新できない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);
    ctx.db.prepare("UPDATE original_roles SET user_id='999' WHERE id=?").run(row.id);

    await handleShopButton(
      press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()),
      ctx.services,
    );

    expect(balance(ctx)).toBe(5_000_000);
    ctx.db.close();
  });
});

describe("期限まわり", () => {
  function activeWithExpiry(ctx: Ctx, expiresAt: number) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.originalRoles.activate({ id: row.id, roleId: "role-1", purchaseId: 1, actor: "t" });
    ctx.db.prepare("UPDATE original_roles SET expires_at=? WHERE id=?").run(expiresAt, row.id);
    return row.id;
  }

  function fakeClient(w: ReturnType<typeof world>, dm: ReturnType<typeof vi.fn>) {
    return {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: dm })) },
    } as never;
  }

  it("期限3日前に本人へ知らせ、二度は送らない", async () => {
    const { notifyExpiringOriginalRoles } = await jobsModule;
    const ctx = setup();
    activeWithExpiry(ctx, Math.floor(Date.now() / 1000) + 2 * DAY);
    const dm = vi.fn(async () => undefined);

    await notifyExpiringOriginalRoles(fakeClient(world(), dm), ctx.services);
    await notifyExpiringOriginalRoles(fakeClient(world(), dm), ctx.services);

    expect(dm).toHaveBeenCalledTimes(1);
    expect(String((dm.mock.calls[0] as never[])[0])).toContain("期限");
    ctx.db.close();
  });

  it("**期限切れでロールを剥奪する**", async () => {
    const { expireOriginalRoles } = await jobsModule;
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) - DAY);
    const w = world();
    w.memberRoles.push("role-1");

    await expireOriginalRoles(fakeClient(w, vi.fn(async () => undefined)), ctx.services);

    expect(w.member.roles.remove).toHaveBeenCalledWith("role-1", expect.any(String));
    expect(w.memberRoles).toHaveLength(0);
    expect(ctx.originalRoles.get(id)!.status).toBe("expired");
    ctx.db.close();
  });

  it("剥奪に失敗しても次の巡回で拾い直す", async () => {
    const { expireOriginalRoles } = await jobsModule;
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) - DAY);
    const w = world();
    w.member.roles.remove = vi.fn(async () => {
      throw new Error("Missing Permissions");
    });

    await expireOriginalRoles(fakeClient(w, vi.fn(async () => undefined)), ctx.services);

    expect(ctx.originalRoles.get(id)!.role_removed_at).toBeNull();
    expect(ctx.originalRoles.listExpired().map((r) => r.id)).toEqual([id]);
    ctx.db.close();
  });

  it("承認から7日で支払いが無ければ取り消し、本人へ知らせる", async () => {
    const { cancelUnpaidOriginalRoles } = await jobsModule;
    const ctx = setup();
    const row = ctx.originalRoles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.db.prepare("UPDATE original_roles SET approved_at=? WHERE id=?").run(
      Math.floor(Date.now() / 1000) - 8 * DAY,
      row.id,
    );
    const dm = vi.fn(async () => undefined);

    await cancelUnpaidOriginalRoles(fakeClient(world(), dm), ctx.services);

    expect(ctx.originalRoles.get(row.id)!.status).toBe("cancelled");
    expect(String((dm.mock.calls[0] as never[])[0])).toContain("取り消し");
    ctx.db.close();
  });
});

describe("作成途中で落ちたとき（Discord側とDBの間のクラッシュ窓）", () => {
  const fakeClient = () => ({ channels: { fetch: async () => null }, users: { fetch: async () => null } }) as never;

  function paidButUnfinished(ctx: Ctx) {
    // 課金と購入行は済んでいるが、契約が始まっていない状態を作る
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    const { purchase } = ctx.shop.purchase({
      userId: USER,
      itemId: ctx.item.id,
      actor: "t",
      memberRoleIds: [],
      request: { applicationId: row.id },
    });
    return { row, purchase };
  }

  const settle = async (ctx: Ctx, w: ReturnType<typeof world>, purchaseId: number) => {
    const { deliverOrRefund } = await import("../src/shop-refund.js");
    return deliverOrRefund(fakeClient(), ctx.services, w.guild as never, ctx.shop.getPurchase(purchaseId)! as never, "system:test");
  };

  it("**一覧を取得できないときは新しいロールを作らない**（無いのか確認できないのかを分ける）", async () => {
    const ctx = setup();
    const w = world({ fetchFails: true });
    const { row, purchase } = paidButUnfinished(ctx);
    const before = balance(ctx);

    const { outcome, refund } = await settle(ctx, w, purchase.id);

    expect(w.guild.roles.create).not.toHaveBeenCalled(); // 確認できないまま2個目を作らない
    expect(outcome.state).toBe("failed");
    expect(refund).toBe("refunded");
    expect(balance(ctx)).toBe(before + PRICE);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved"); // 次の支払いでやり直せる
    ctx.db.close();
  });

  it("**開始前からあった同名のロールは拾わない**（別人のロールを掴まない）", async () => {
    const ctx = setup();
    const w = world();
    const stranger = w.makeRole("冥き翼"); // 他人が先に持っていた同名ロール
    const { row, purchase } = paidButUnfinished(ctx);
    // 作りにいった印はあるが、自分のロールはまだ無い状況。ここで同名を拾ってはいけない
    ctx.originalRoles.markRoleCreationStarted(row.id);

    await settle(ctx, w, purchase.id);

    const after = ctx.originalRoles.get(row.id)!;
    expect(after.role_id).not.toBe(stranger.id);
    expect(w.guild.roles.create).toHaveBeenCalledTimes(1); // 自分のぶんを作る
    expect(after.status).toBe("active");
    ctx.db.close();
  });

  it("**作った直後に落ちても、自分のロールだけを一意に回収する**", async () => {
    const { stagingRoleName } = await import("../src/shop-delivery.js");
    const ctx = setup();
    const w = world();
    const { row, purchase } = paidButUnfinished(ctx);
    // 申請IDを埋めた仮名で作った直後に落ちた状況（role_id を書く前）
    ctx.originalRoles.markRoleCreationStarted(row.id);
    const mine = w.makeRole(stagingRoleName(row.id));
    const stranger = w.makeRole("冥き翼"); // 紛らわしい他人のロール

    await settle(ctx, w, purchase.id);

    expect(w.guild.roles.create).not.toHaveBeenCalled(); // 2個目を作らない
    const after = ctx.originalRoles.get(row.id)!;
    expect(after.role_id).toBe(mine.id);
    expect(after.role_id).not.toBe(stranger.id);
    expect(mine.name).toBe("冥き翼"); // 仮名から本来の名前へ変わっている
    expect(w.memberRoles).toEqual([mine.id]);
    expect(after.status).toBe("active");
    ctx.db.close();
  });

  it("既に自分のロールが記録されていれば、それを使って付与だけやり直す", async () => {
    const ctx = setup();
    const w = world();
    const { row, purchase } = paidButUnfinished(ctx);
    const known = w.makeRole("冥き翼");
    ctx.originalRoles.markRoleCreationStarted(row.id);
    ctx.originalRoles.attachRole(row.id, known.id, "system:test");

    await settle(ctx, w, purchase.id);

    expect(w.guild.roles.create).not.toHaveBeenCalled();
    expect(w.memberRoles).toEqual([known.id]);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("記録したロールが消されていたら、作り直して契約を始める", async () => {
    const ctx = setup();
    const w = world();
    const { row, purchase } = paidButUnfinished(ctx);
    ctx.originalRoles.attachRole(row.id, "role-deleted-by-human", "system:test");

    await settle(ctx, w, purchase.id);

    expect(w.guild.roles.create).toHaveBeenCalledTimes(1);
    const after = ctx.originalRoles.get(row.id)!;
    expect(after.status).toBe("active");
    expect(after.role_id).not.toBe("role-deleted-by-human");
    ctx.db.close();
  });

  it("**付与したあとに契約を開始できなければ、付与を戻してから返金する**", async () => {
    const ctx = setup();
    const w = world();
    const { row, purchase } = paidButUnfinished(ctx);
    // 引き継ぎ等で拾った既存ロール（消してはいけない）
    const recovered = w.makeRole("冥き翼");
    ctx.originalRoles.markRoleCreationStarted(row.id);
    ctx.originalRoles.attachRole(row.id, recovered.id, "system:test");
    // 付与のあと・activate の直前に、別経路が申請をさらっていった状況を作る
    const realActivate = ctx.originalRoles.activate.bind(ctx.originalRoles);
    vi.spyOn(ctx.originalRoles, "activate").mockImplementationOnce(() => {
      ctx.db.prepare("UPDATE original_roles SET status='cancelled' WHERE id=?").run(row.id);
      return realActivate({ id: row.id, roleId: recovered.id, purchaseId: purchase.id, actor: "t" });
    });
    const before = balance(ctx);

    const { outcome, refund } = await settle(ctx, w, purchase.id);

    expect(outcome.state).toBe("failed");
    expect(refund).toBe("refunded");
    expect(balance(ctx)).toBe(before + PRICE);
    expect(w.memberRoles).toEqual([]); // **本人にロールが残らない**
    expect(w.roleDeleted).not.toContain(recovered.id); // 拾った既存ロールは消さない
    expect(w.living.has(recovered.id)).toBe(true);
    vi.restoreAllMocks();
    ctx.db.close();
  });

  it("**再起動後の巡回が、払ったまま止まっている購入を自動で収束させる**", async () => {
    const { convergePendingOriginalRoles } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    const w = world();
    const { row, purchase } = paidButUnfinished(ctx);
    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => null) },
      channels: { fetch: vi.fn(async () => null) },
    };

    await convergePendingOriginalRoles(client as never, ctx.services);

    expect(ctx.originalRoles.get(row.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(w.memberRoles).toHaveLength(1);
    ctx.db.close();
  });

  it("作れないまま巡回に拾われたら返金する（返金できたら人を呼ばない）", async () => {
    const { convergePendingOriginalRoles } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    const w = world({ createFails: "Missing Permissions" });
    const { purchase } = paidButUnfinished(ctx);
    const before = balance(ctx);
    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => null) },
      channels: { fetch: vi.fn(async () => null) },
    };

    await convergePendingOriginalRoles(client as never, ctx.services);

    expect(balance(ctx)).toBe(before + PRICE);
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("refunded");
    ctx.db.close();
  });
});

describe("支払いのやり直し", () => {
  function approved(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    return row;
  }
  const payId = (ctx: Ctx, appId: number, attempt: string) =>
    `shop:orole-pay:${ctx.item.id}:${appId}:${PRICE}:${attempt}`;

  it("同じ支払い画面を二度押しても課金は1回", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const before = balance(ctx);

    await handleShopButton(press(ctx, payId(ctx, row.id, "a1"), w), ctx.services);
    await handleShopButton(press(ctx, payId(ctx, row.id, "a1"), w), ctx.services);

    expect(balance(ctx)).toBe(before - PRICE);
    expect(ctx.shop.listUserPurchases(USER).filter((p) => p.status === "active")).toHaveLength(1);
    expect(w.guild.roles.create).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });

  it("**返金されたあとは、開き直せばもう一度支払える**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const before = balance(ctx);
    // 1回目は作成に失敗 → 自動返金
    await handleShopButton(press(ctx, payId(ctx, row.id, "a1"), world({ createFails: "boom" })), ctx.services);
    expect(balance(ctx)).toBe(before);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved");

    // 商品を開き直すと新しい鍵になる
    const w2 = world();
    await handleShopButton(press(ctx, payId(ctx, row.id, "a2"), w2), ctx.services);

    expect(balance(ctx)).toBe(before - PRICE);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("active");
    expect(w2.memberRoles).toHaveLength(1);
    ctx.db.close();
  });

  it("**別々の鍵で同時に押されても、二重課金・二重作成しない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const before = balance(ctx);

    await Promise.all([
      handleShopButton(press(ctx, payId(ctx, row.id, "a1"), w), ctx.services),
      handleShopButton(press(ctx, payId(ctx, row.id, "a2"), w), ctx.services),
    ]);

    expect(balance(ctx)).toBe(before - PRICE);
    expect(ctx.shop.listUserPurchases(USER).filter((p) => p.status === "active")).toHaveLength(1);
    expect(w.guild.roles.create).toHaveBeenCalledTimes(1);
    expect(w.memberRoles).toHaveLength(1);
    ctx.db.close();
  });
});

describe("旧契約の引き継ぎ（運営導線）", () => {
  const importUi = () => import("../src/commands/original-role-import.js");
  const held = (w: ReturnType<typeof world>, name: string) => {
    const role = w.makeRole(name);
    w.member.roles.cache.set(role.id, true);
    return role;
  };
  const runId = (userId: string, roleId: string, expires: number) =>
    `mgmt:recover:orole-import-run:${userId}:${roleId}:${expires}`;
  const EXPIRES = Math.floor(Date.now() / 1000) + 10 * DAY;

  it("**購入履歴からロールを推測しない**（人が選んだロールだけを登録する）", async () => {
    const { importConfirm, handleImportRun } = await importUi();
    const ctx = setup();
    const w = world();
    const role = held(w, "旧オリジナル");
    const view = await importConfirm(ctx.services, w.guild as never, USER, role.id);

    // 確認画面に buyer / role / 期限 が全部出ている
    const fields = (view.embeds[0]!.toJSON().fields ?? []).map((f) => `${f.name}:${f.value}`).join("|");
    expect(fields).toContain(USER);
    expect(fields).toContain(role.id);
    expect(fields).toContain("期限");
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(false);

    await handleImportRun(press(ctx, runId(USER, role.id, EXPIRES), w) as never, ctx.services);

    const rows = ctx.originalRoles.listByUser(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role_id).toBe(role.id);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.expires_at).toBe(EXPIRES);
    ctx.db.close();
  });

  it("**本人が持っていないロールは登録できない**", async () => {
    const { importConfirm, handleImportRun } = await importUi();
    const ctx = setup();
    const w = world();
    const role = w.makeRole("誰かの飾り"); // 本人は持っていない

    const view = await importConfirm(ctx.services, w.guild as never, USER, role.id);
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(true);

    const btn = press(ctx, runId(USER, role.id, EXPIRES), w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleImportRun(btn as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(contentOf(btn.update)).toContain("持っていません");
    ctx.db.close();
  });

  it("**Botが外せないロールは登録できない**（期限切れに剥奪できない）", async () => {
    const { importConfirm, handleImportRun } = await importUi();
    const ctx = setup();
    const w = world({ notRemovable: true });
    const role = held(w, "上位ロール");

    const view = await importConfirm(ctx.services, w.guild as never, USER, role.id);
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(true);

    const btn = press(ctx, runId(USER, role.id, EXPIRES), w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleImportRun(btn as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(contentOf(btn.update)).toContain("外せません");
    ctx.db.close();
  });

  it("連携ロール・@everyone は登録できない", async () => {
    const { checkImportTarget } = await importUi();
    const ctx = setup();
    const w = world();
    const bot = held(w, "統合Bot");
    bot.managed = true;

    expect(await checkImportTarget(w.guild as never, USER, bot.id)).toEqual({ ok: false, reason: "managed" });
    expect(await checkImportTarget(w.guild as never, USER, w.guild.id)).toEqual({ ok: false, reason: "everyone" });
    ctx.db.close();
  });

  it("Discordを確認できないときは登録しない", async () => {
    const { handleImportRun } = await importUi();
    const ctx = setup();
    const w = world({ fetchFails: true });

    const btn = press(ctx, runId(USER, "role-x", EXPIRES), w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleImportRun(btn as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(contentOf(btn.update)).toContain("確認できませんでした");
    ctx.db.close();
  });

  it("同じロールは二重に登録できない（2件目は何も書かない）", async () => {
    const { handleImportRun, importConfirm } = await importUi();
    const ctx = setup();
    const w = world();
    const role = held(w, "旧オリジナル");
    await handleImportRun(press(ctx, runId(USER, role.id, EXPIRES), w) as never, ctx.services);

    const other = press(ctx, runId("999", role.id, EXPIRES), w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleImportRun(other as never, ctx.services);

    expect(ctx.originalRoles.listByUser("999")).toHaveLength(0);
    expect(contentOf(other.update)).toContain("何も登録していません");
    // 確認画面の段階でも押せないようにしてある
    const view = await importConfirm(ctx.services, w.guild as never, "999", role.id);
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(true);
    ctx.db.close();
  });

  it("引き継いだ契約は、本人が更新できる", async () => {
    const { handleImportRun } = await importUi();
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world();
    const role = held(w, "旧オリジナル");
    await handleImportRun(press(ctx, runId(USER, role.id, EXPIRES), w) as never, ctx.services);
    const contract = ctx.originalRoles.listByUser(USER)[0]!;
    const before = balance(ctx);

    await handleShopButton(
      press(ctx, `shop:orole-renew-do:${ctx.item.id}:${contract.id}:${RENEW}:op-import`, w),
      ctx.services,
    );

    expect(balance(ctx)).toBe(before - RENEW);
    expect(ctx.originalRoles.get(contract.id)!.expires_at).toBe(EXPIRES + 30 * DAY);
    ctx.db.close();
  });

  it("旧商品の残件を一覧に出す（誰がまだ未登録か分かる）", async () => {
    const { importHome } = await importUi();
    const ctx = setup();
    const legacy = ctx.shop.createItem(
      { name: "オリジナルロール継続or付与 月額", price_land: RENEW, kind: "monthly", delivery: "manual" },
      "staff",
    );
    ctx.settings.set("shop:original_role_legacy_item_id", String(legacy.id), "staff");
    ctx.shop.purchase({ userId: USER, itemId: legacy.id, actor: "t", memberRoleIds: [] });

    const text = String(importHome(ctx.services).embeds[0]!.toJSON().description);

    expect(text).toContain("未登録 **1件**");
    expect(text).toContain(USER);
    ctx.db.close();
  });
});

describe("表示した価格で払う", () => {
  function approved(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    return row;
  }

  it("**表示後に値上げされても、古いボタンでは1 Ldも動かない。再確認すれば新価格で1回だけ**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const { payRequote } = await import("../src/commands/original-role.js");
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const before = balance(ctx);

    // 750,000 と表示されたボタンを持ったまま、運営が 800,000 へ変更
    const stale = press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w) as unknown as {
      update: ReturnType<typeof vi.fn>;
    };
    ctx.shop.updateItem(ctx.item.id, { price_land: 800_000 }, "staff");

    await handleShopButton(stale as never, ctx.services);

    expect(balance(ctx)).toBe(before); // **無課金**
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(w.guild.roles.create).not.toHaveBeenCalled();
    expect(contentOf(stale.update)).toContain("まだ引き落としていません");

    // 再確認の画面には新しい額と新しい鍵が載っている
    const requote = payRequote(ctx.shop.getItem(ctx.item.id)!, row.id, "冥き翼");
    const nextId = String(requote.components[0]!.toJSON().components[0]!.custom_id);
    expect(nextId).toContain(`:${row.id}:800000:`);
    expect(nextId).not.toBe(`shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`);

    await handleShopButton(press(ctx, nextId, w), ctx.services);
    await handleShopButton(press(ctx, nextId, w), ctx.services); // 二度押しても1回

    expect(balance(ctx)).toBe(before - 800_000);
    expect(ctx.shop.listUserPurchases(USER).filter((p) => p.status === "active")).toHaveLength(1);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("値下げされていても、表示した額と違えば引かずに確かめ直す", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const before = balance(ctx);
    ctx.shop.updateItem(ctx.item.id, { price_land: 500_000 }, "staff");

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}:${PRICE}:a1`, w), ctx.services);

    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });
});

describe("Discordの反映をエラーだけで決めない", () => {
  const fakeClient = () => ({ channels: { fetch: async () => null }, users: { fetch: async () => null } }) as never;

  function paidButUnfinished(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    const { purchase } = ctx.shop.purchase({
      userId: USER,
      itemId: ctx.item.id,
      actor: "t",
      memberRoleIds: [],
      request: { applicationId: row.id },
    });
    return { row, purchase };
  }

  const settle = async (ctx: Ctx, w: ReturnType<typeof world>, purchaseId: number) => {
    const { deliverOrRefund } = await import("../src/shop-refund.js");
    return deliverOrRefund(fakeClient(), ctx.services, w.guild as never, ctx.shop.getPurchase(purchaseId)! as never, "system:test");
  };

  it("**付与がエラーでも、実際に付いていれば契約を始める**（返金しない）", async () => {
    const ctx = setup();
    // エラーを返しつつ、Discord側では付与が通っていた状況
    const w = world({ addFails: "Service Unavailable", addActuallyApplies: true });
    const { row, purchase } = paidButUnfinished(ctx);
    const before = balance(ctx);

    const { outcome, refund } = await settle(ctx, w, purchase.id);

    expect(outcome.state).toBe("delivered");
    expect(refund).toBeUndefined();
    expect(balance(ctx)).toBe(before);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("付与がエラーで、実際にも付いていなければ失敗して返金する", async () => {
    const ctx = setup();
    const w = world({ addFails: "Missing Permissions" });
    const { purchase } = paidButUnfinished(ctx);
    const before = balance(ctx);

    const { outcome, refund } = await settle(ctx, w, purchase.id);

    expect(outcome.state).toBe("failed");
    expect(refund).toBe("refunded");
    expect(balance(ctx)).toBe(before + PRICE);
    ctx.db.close();
  });

  it("**契約に失敗し、ロールも外せず残っているなら自動返金しない**（人へ渡す）", async () => {
    const ctx = setup();
    const w = world({ removeFails: true });
    const { row, purchase } = paidButUnfinished(ctx);
    const recovered = w.makeRole("冥き翼");
    ctx.originalRoles.markRoleCreationStarted(row.id);
    ctx.originalRoles.attachRole(row.id, recovered.id, "system:test");
    const realActivate = ctx.originalRoles.activate.bind(ctx.originalRoles);
    vi.spyOn(ctx.originalRoles, "activate").mockImplementationOnce(() => {
      ctx.db.prepare("UPDATE original_roles SET status='cancelled' WHERE id=?").run(row.id);
      return realActivate({ id: row.id, roleId: recovered.id, purchaseId: purchase.id, actor: "t" });
    });
    const before = balance(ctx);

    const { outcome, refund } = await settle(ctx, w, purchase.id);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(false);
    expect(refund).toBe("escalated"); // 運営対応へ
    expect(balance(ctx)).toBe(before); // **返金していない**
    expect(w.memberRoles).toContain(recovered.id); // ロールは本人に残ったまま
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    vi.restoreAllMocks();
    ctx.db.close();
  });

  it("剥奪がエラーでも、実際に外れていれば返金して収束する", async () => {
    const ctx = setup();
    const w = world({ removeFails: true, removeActuallyApplies: true });
    const { row, purchase } = paidButUnfinished(ctx);
    const recovered = w.makeRole("冥き翼");
    ctx.originalRoles.markRoleCreationStarted(row.id);
    ctx.originalRoles.attachRole(row.id, recovered.id, "system:test");
    const realActivate = ctx.originalRoles.activate.bind(ctx.originalRoles);
    vi.spyOn(ctx.originalRoles, "activate").mockImplementationOnce(() => {
      ctx.db.prepare("UPDATE original_roles SET status='cancelled' WHERE id=?").run(row.id);
      return realActivate({ id: row.id, roleId: recovered.id, purchaseId: purchase.id, actor: "t" });
    });
    const before = balance(ctx);

    const { refund } = await settle(ctx, w, purchase.id);

    expect(refund).toBe("refunded");
    expect(balance(ctx)).toBe(before + PRICE);
    expect(w.memberRoles).not.toContain(recovered.id);
    vi.restoreAllMocks();
    ctx.db.close();
  });
});
