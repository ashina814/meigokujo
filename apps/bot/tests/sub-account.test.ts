import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection } from "discord.js";
import {
  Entry,
  EventLog,
  Ledger,
  Settings,
  Shop,
  SubAccounts,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { hasUnresolvedLegacySubAccount } from "../src/commands/sub-account.js";
import { deactivateSubAccount } from "../src/sub-account-deactivation.js";

/**
 * サブ垢の導線。
 *
 * - 申請・承認では **Land を動かさない**
 * - 支払い直前にも階級を見る（承認後の降格で課金しない）
 * - 有効化は **`ghostify` を流用しない**（初期発行も評価期間も生やさない）
 * - 有効化に失敗したら自動返金。戻せたか確認できないときは返金しない
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");

const MAIN = "1463201396567441441";
const ALT = "1463201396567441442";
const ALT2 = "1463201396567441443";
const PRICE = 80_000;
const MAJIN_ROLE = "role-majin";

function setup(mainStatus: "majin" | "meirei" | "ghost" = "majin", path = ":memory:") {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const entry = new Entry(db, ledger, events, settings);
  const subAccounts = new SubAccounts(db, events);
  const item = shop.createItem(
    { name: "サブ垢追加", price_land: PRICE, kind: "one_shot", delivery: "auto", delivery_kind: "activate_sub_account" },
    "staff",
  );
  settings.set("guild:main", "g1", "staff");
  settings.set("shop:sub_account_item_id", String(item.id), "staff");
  settings.set("role:majin", MAJIN_ROLE, "staff");
  settings.set("role:ghost", "role-ghost", "staff");
  settings.set("role:kenma", "role-kenma", "staff");
  settings.set("role:mazoku", "role-mazoku", "staff");
  settings.set("role:meirei", "role-meirei", "staff");
  // 本体の階級は台帳が正本。Discordのロールは見ない
  const ts = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO souls (user_id,status,joined_at,updated_at) VALUES (?,?,?,?)").run(MAIN, mainStatus, ts, ts);
  ledger.ensureAccount(`user:${MAIN}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${MAIN}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  const services = { db, ledger, settings, events, shop, entry, subAccounts } as unknown as Services;
  return { db, ledger, settings, events, shop, entry, subAccounts, item, services };
}

/** 同じDBを開き直す（再起動相当）。**種まきはしない** */
function reopen(path: string): Ctx {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const entry = new Entry(db, ledger, events, settings);
  const subAccounts = new SubAccounts(db, events);
  const item = shop.getItem(Number(settings.getString("shop:sub_account_item_id")))!;
  const services = { db, ledger, settings, events, shop, entry, subAccounts } as unknown as Services;
  return { db, ledger, settings, events, shop, entry, subAccounts, item, services };
}

type Ctx = ReturnType<typeof setup>;
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${MAIN}`);

function world(
  opts: {
    addFails?: string;
    /** このロールの付与だけ失敗させる（未指定なら全部） */
    addFailsFor?: string;
    addActuallyApplies?: boolean;
    removeFails?: boolean;
    /** エラーを返すが、Discord側では剥奪が通っていた */
    removeActuallyApplies?: boolean;
    /** 取り直し（force fetch）が失敗する＝実状態を確認できない */
    forceFetchFails?: boolean;
    /** N回目以降の force fetch だけ失敗させる（途中まで進んでから確認不能になる） */
    forceFetchFailsAfter?: number;
    /** 実体には無いが、**古いcacheにだけ**載っているロール */
    staleOnly?: string[];
    altMissing?: boolean;
  } = {},
) {
  const altRoles: string[] = [];
  const cache = new Collection<string, unknown>();
  const alt = {
    id: ALT,
    roles: {
      cache,
      add: vi.fn(async (id: string) => {
        if (opts.addFails && (opts.addFailsFor === undefined || opts.addFailsFor === id)) {
          if (opts.addActuallyApplies) {
            altRoles.push(id);
            cache.set(id, true);
          }
          throw new Error(opts.addFails);
        }
        altRoles.push(id);
        cache.set(id, true);
      }),
      remove: vi.fn(async (id: string) => {
        const drop = () => {
          const i = altRoles.indexOf(id);
          if (i >= 0) altRoles.splice(i, 1);
          cache.delete(id);
        };
        if (opts.removeFails) {
          if (opts.removeActuallyApplies) drop();
          throw new Error("Service Unavailable");
        }
        drop();
      }),
    },
  };
  // 古いcache。**実体には無いロールが載っている**状況を作れる
  const staleCache = new Collection<string, unknown>();
  for (const id of opts.staleOnly ?? []) staleCache.set(id, true);
  const staleAlt = { id: ALT, roles: { ...alt.roles, cache: staleCache } };
  let forceCalls = 0;
  const guild = {
    id: "g1",
    members: {
      fetch: vi.fn(async (arg?: unknown) => {
        if (opts.altMissing) throw new Error("Unknown Member");
        const isForce = typeof arg === "object" && arg !== null;
        if (!isForce) return (opts.staleOnly ? staleAlt : alt) as never;
        // 取り直し（{ user, force }）だけ失敗させられるようにする
        forceCalls += 1;
        if (opts.forceFetchFails) throw new Error("Service Unavailable");
        if (opts.forceFetchFailsAfter !== undefined && forceCalls >= opts.forceFetchFailsAfter) {
          throw new Error("Service Unavailable");
        }
        return alt;
      }),
    },
    roles: { cache: new Collection() },
  };
  return { guild, alt, altRoles, staleCache };
}

function press(customId: string, w: ReturnType<typeof world>, userId = MAIN, extra: Record<string, unknown> = {}) {
  return {
    customId,
    id: `int-${Math.random()}`,
    user: { id: userId },
    guild: w.guild,
    member: { id: userId, roles: { cache: new Collection() } },
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
const payId = (
  ctx: Ctx,
  appId: number,
  attempt = "a1",
  // tokenはCoreが正本。テスト側で同じhashを組み立てない。
  termsToken: string = ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
) => `shop:sub-pay:${ctx.item.id}:${appId}:${PRICE}:${termsToken}:${attempt}`;

function approved(ctx: Ctx) {
  const row = ctx.subAccounts.apply({ mainUserId: MAIN, altUserId: ALT, mainStatus: "majin", actor: "t" });
  ctx.subAccounts.approve(row.id, "staff", "majin");
  return row;
}

describe("申請", () => {
  it("**申請では Land を動かさない**", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const m = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(MAIN)).toHaveLength(0);
    expect(ctx.subAccounts.listByMain(MAIN)[0]!.status).toBe("pending");
    expect(contentOf(m.reply)).toContain("課金していません");
    ctx.db.close();
  });

  it("**迷霊は申請できない**（旧商品#4の資格外購入と同じ形を作らない）", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup("meirei");
    const m = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("魔人以上");
    ctx.db.close();
  });

  it("IDの形式が違えば申請を作らない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const m = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => "だれか" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("Discord ID");
    ctx.db.close();
  });
});

describe("旧契約の二重課金防止", () => {
  function legacyPurchase(ctx: Ctx, status: "active" | "refunded" = "active") {
    const legacy = ctx.shop.createItem(
      { name: "サブ垢追加(旧)", price_land: PRICE, kind: "one_shot", delivery: "manual" },
      "staff",
    );
    ctx.settings.set("shop:sub_account_legacy_item_id", String(legacy.id), "staff");
    const outcome = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(legacy.id).termsToken, userId: MAIN, itemId: legacy.id, actor: "t", memberRoleIds: [] });
    if (status === "refunded") ctx.shop.refund(outcome.purchase.id, "test", "staff");
    return outcome.purchase;
  }

  it("legacy active + 未引き継ぎならbuttonとmodalの両方で止め、申請もLand移動もない", async () => {
    const { handleShopButton, handleShopModal } = await shopPanelModule;
    const ctx = setup();
    legacyPurchase(ctx);
    const before = balance(ctx);
    const w = world();
    const button = press(`shop:sub-apply:${ctx.item.id}`, w) as unknown as {
      showModal: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    const modal = press(`shop:sub-input:${ctx.item.id}`, w, MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopButton(button as never, ctx.services);
    await handleShopModal(modal as never, ctx.services);

    expect(button.showModal).not.toHaveBeenCalled();
    expect(contentOf(button.update)).toContain("旧サブ垢契約が残っています");
    expect(contentOf(modal.reply)).toContain("二重に支払わず");
    expect(ctx.subAccounts.listByMain(MAIN)).toHaveLength(0);
    expect(hasUnresolvedLegacySubAccount(ctx.services, MAIN)).toBe(true);
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("legacy activeでもactive sub_accountsがあれば通常の追加申請ルールへ進む", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    legacyPurchase(ctx);
    const imported = ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    expect(imported.legacy_imported_at).not.toBeNull();
    expect(hasUnresolvedLegacySubAccount(ctx.services, MAIN)).toBe(false);
    const before = balance(ctx);
    const modal = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT2 },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(modal as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN).map((row) => row.status)).toEqual(["active", "pending"]);
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("legacy import済み契約を正式解除してもblockerは復活せず、Land・旧purchaseを変えず再申請できる", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const purchase = legacyPurchase(ctx);
    const imported = ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const before = balance(ctx);
    const w = world();
    w.altRoles.push(MAJIN_ROLE);
    w.alt.roles.cache.set(MAJIN_ROLE, true);

    expect((await deactivateSubAccount(ctx.services, w.guild as never, imported.id, "staff")).ok).toBe(true);
    expect(ctx.subAccounts.get(imported.id)).toMatchObject({ status: "cancelled", legacy_imported_at: expect.any(Number) });
    expect(hasUnresolvedLegacySubAccount(ctx.services, MAIN)).toBe(false);

    const modal = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT2 },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };
    await handleShopModal(modal as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)).toMatchObject([{ status: "pending", alt_user_id: ALT2 }]);
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("legacy refundedはblockerにならない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    legacyPurchase(ctx, "refunded");
    const before = balance(ctx);
    const modal = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(modal as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)[0]!.status).toBe("pending");
    expect(hasUnresolvedLegacySubAccount(ctx.services, MAIN)).toBe(false);
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("legacy設定が未設定なら通常動作する", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const before = balance(ctx);
    const modal = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(modal as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)[0]!.status).toBe("pending");
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });
});

describe("支払いと有効化", () => {
  it("支払うと本体と同じ階級が付き、サブ垢が有効になる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    ctx.db.close();
  });

  it("**`ghostify` を流用しない**（サブ垢に初期発行も評価期間も生やさない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);

    await handleShopButton(press(payId(ctx, row.id), world()), ctx.services);

    // サブ垢側に soul も口座残高もできていない
    expect(ctx.entry.getSoul(ALT)).toBeUndefined();
    expect(ctx.ledger.balanceOf(`user:${ALT}`)).toBe(0);
    expect(
      (ctx.db.prepare("SELECT COUNT(*) c FROM transactions WHERE to_account=?").get(`user:${ALT}`) as { c: number }).c,
    ).toBe(0);
    ctx.db.close();
  });

  it("**承認後に降格していたら、80,000Ldを引かずに止める**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    // 承認のあとに迷霊へ落ちた
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(MAIN);
    const w = world();
    const p = press(payId(ctx, row.id), w) as unknown as { editReply: ReturnType<typeof vi.fn> };

    await handleShopButton(p as never, ctx.services);

    expect(balance(ctx)).toBe(1_000_000); // **1 Ld も動かない**
    expect(ctx.shop.listUserPurchases(MAIN)).toHaveLength(0);
    expect(w.altRoles).toEqual([]);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved");
    expect(contentOf(p.editReply)).toContain("魔人以上");
    ctx.db.close();
  });

  it("同じ支払い画面を二度押しても課金は1回", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);
    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    expect(ctx.shop.listUserPurchases(MAIN).filter((p) => p.status === "active")).toHaveLength(1);
    ctx.db.close();
  });

  it("表示後に値上げされても、古いボタンでは1 Ldも動かない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    // 値上げの**前**に描画されたボタンを持つ（実際の利用者と同じ順序）
    const staleButton = payId(ctx, row.id);
    ctx.shop.updateItem(ctx.item.id, { price_land: 120_000 }, "staff");

    await handleShopButton(press(staleButton, w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(MAIN)).toHaveLength(0);
    ctx.db.close();
  });

  it("サブ垢がサーバーにいなければ有効化せず返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ altMissing: true });

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved"); // 払い直せる
    ctx.db.close();
  });

  it("**付与がエラーでも、実際に付いていれば有効化する**（返金しない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ addFails: "Service Unavailable", addActuallyApplies: true });

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    ctx.db.close();
  });
});

describe("再起動後の収束", () => {
  it("課金済みで有効化されていないサブ垢を、巡回がやりきる", async () => {
    const { convergePendingSubAccounts } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    const row = approved(ctx);
    const { purchase } = ctx.shop.purchase({
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
      userId: MAIN,
      itemId: ctx.item.id,
      actor: "t",
      memberRoleIds: [],
      request: { applicationId: row.id },
    });
    const w = world();
    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => null) },
      channels: { fetch: vi.fn(async () => null) },
    };

    await convergePendingSubAccounts(client as never, ctx.services);

    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(w.altRoles).toEqual([MAJIN_ROLE]);
    ctx.db.close();
  });
});

describe("階級の追従", () => {
  it("**本体の現在階級を正本にする**（本体が上がればサブ垢も上がる）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup("ghost");
    ctx.settings.set("role:mazoku", "role-mazoku", "staff");
    ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const w = world();
    w.alt.roles.cache.set("role-ghost", true);
    w.altRoles.push("role-ghost");
    ctx.db.prepare("UPDATE souls SET status='mazoku' WHERE user_id=?").run(MAIN);
    const client = { guilds: { fetch: vi.fn(async () => w.guild) } };

    await syncSubAccountRanks(client as never, ctx.services);

    expect(w.altRoles).toEqual(["role-mazoku"]);
    ctx.db.close();
  });

  it("**本体が迷霊に落ちたら、サブ垢から階級ロールを外す**", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const w = world();
    w.alt.roles.cache.set(MAJIN_ROLE, true);
    w.altRoles.push(MAJIN_ROLE);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(MAIN);
    const client = { guilds: { fetch: vi.fn(async () => w.guild) } };

    await syncSubAccountRanks(client as never, ctx.services);

    expect(w.altRoles).toEqual([]);
    ctx.db.close();
  });

  it("既に合っていれば何もしない（毎分の巡回で同じ結果に収束する）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const w = world();
    w.alt.roles.cache.set(MAJIN_ROLE, true);
    w.altRoles.push(MAJIN_ROLE);
    const client = { guilds: { fetch: vi.fn(async () => w.guild) } };

    await syncSubAccountRanks(client as never, ctx.services);

    expect(w.alt.roles.add).not.toHaveBeenCalled();
    expect(w.alt.roles.remove).not.toHaveBeenCalled();
    ctx.db.close();
  });
});

describe("旧#4の引き継ぎ（運営導線）", () => {
  const importUi = () => import("../src/commands/sub-account-import.js");

  it("**購入履歴からサブ垢を推測しない**（人が選んだ組み合わせだけを登録する）", async () => {
    const { handleImportRun, importConfirm } = await importUi();
    const ctx = setup();
    const w = world();

    const view = await importConfirm(ctx.services, w.guild as never, MAIN, ALT);
    const fields = (view.embeds[0]!.toJSON().fields ?? []).map((f) => `${f.name}:${f.value}`).join("|");
    expect(fields).toContain(MAIN);
    expect(fields).toContain(ALT);
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(false);

    await handleImportRun(press(`mgmt:recover:sub-import-run:${MAIN}:${ALT}`, w) as never, ctx.services);

    expect(ctx.subAccounts.findByAlt(ALT)?.main_user_id).toBe(MAIN);
    ctx.db.close();
  });

  it("サーバーにいないアカウントは登録できない", async () => {
    const { handleImportRun } = await importUi();
    const ctx = setup();
    const w = world({ altMissing: true });
    const btn = press(`mgmt:recover:sub-import-run:${MAIN}:${ALT}`, w) as unknown as {
      update: ReturnType<typeof vi.fn>;
    };

    await handleImportRun(btn as never, ctx.services);

    expect(ctx.subAccounts.findByAlt(ALT)).toBeNull();
    expect(contentOf(btn.update)).toContain("何も登録していません");
    ctx.db.close();
  });

  it("同じサブ垢は二重に登録できない", async () => {
    const { handleImportRun, importConfirm } = await importUi();
    const ctx = setup();
    const w = world();
    await handleImportRun(press(`mgmt:recover:sub-import-run:${MAIN}:${ALT}`, w) as never, ctx.services);

    const other = press(`mgmt:recover:sub-import-run:999:${ALT}`, w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleImportRun(other as never, ctx.services);

    expect(ctx.subAccounts.findByAlt(ALT)?.main_user_id).toBe(MAIN);
    expect(contentOf(other.update)).toContain("何も登録していません");
    const view = await importConfirm(ctx.services, w.guild as never, "999", ALT);
    expect(view.components[0]!.toJSON().components[0]!.disabled).toBe(true);
    ctx.db.close();
  });

  it("旧商品の残件を一覧に出す", async () => {
    const { importHome } = await importUi();
    const ctx = setup();
    const legacy = ctx.shop.createItem({ name: "サブ垢追加(旧)", price_land: PRICE, kind: "one_shot", delivery: "manual" }, "staff");
    ctx.settings.set("shop:sub_account_legacy_item_id", String(legacy.id), "staff");
    ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(legacy.id).termsToken, userId: MAIN, itemId: legacy.id, actor: "t", memberRoleIds: [] });

    const text = String(importHome(ctx.services).embeds[0]!.toJSON().description);

    expect(text).toContain("未登録 **1件**");
    expect(text).toContain(MAIN);
    ctx.db.close();
  });
});

describe("階級同期は実状態で判定する", () => {
  const MAZOKU_ROLE = "role-mazoku";
  const clientOf = (w: ReturnType<typeof world>) => ({ guilds: { fetch: vi.fn(async () => w.guild) } }) as never;
  const syncedEvents = (ctx: Ctx) =>
    ctx.db.prepare("SELECT type FROM events WHERE type LIKE 'sub_account_rank_sync%'").all() as Array<{ type: string }>;

  function activeSub(ctx: Ctx) {
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    return ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
  }

  it("**剥奪に失敗したら下位ロールを足さない**（魔族+魔人の二重階級を作らない）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup(); // main = 魔人
    activeSub(ctx);
    const w = world({ removeFails: true });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(w.altRoles).toEqual([MAZOKU_ROLE]); // 魔人を足していない
    expect(w.alt.roles.add).not.toHaveBeenCalled();
    expect(syncedEvents(ctx).map((e) => e.type)).toEqual(["sub_account_rank_sync_failed"]);
    ctx.db.close();
  });

  it("**本体が迷霊で剥奪に失敗したら「同期済み」にしない**（古いロールが残っているのを検知する）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    activeSub(ctx);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(MAIN);
    const w = world({ removeFails: true });
    w.alt.roles.cache.set(MAJIN_ROLE, true);
    w.altRoles.push(MAJIN_ROLE);

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]); // 外れていない
    const events = syncedEvents(ctx);
    expect(events.map((e) => e.type)).toEqual(["sub_account_rank_sync_failed"]);
    const payload = String(
      (ctx.db.prepare("SELECT payload_json p FROM events WHERE type='sub_account_rank_sync_failed'").get() as { p: string }).p,
    );
    expect(payload).toContain(MAJIN_ROLE); // 何が残っているか記録に出る
    ctx.db.close();
  });

  it("**剥奪がエラーでも実際には外れていれば成功にする**（取り直して確かめる）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    activeSub(ctx);
    const w = world({ removeFails: true, removeActuallyApplies: true });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]);
    expect(syncedEvents(ctx).map((e) => e.type)).toEqual(["sub_account_rank_synced"]);
    ctx.db.close();
  });

  it("実状態を確認できないときは成功にしない", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    activeSub(ctx);
    const w = world({ forceFetchFails: true });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(syncedEvents(ctx).map((e) => e.type)).toEqual(["sub_account_rank_sync_failed"]);
    ctx.db.close();
  });

  it("**初回有効化でも、別の階級ロールが残っていれば正規化してから active にする**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    const row = approved(ctx);
    const w = world();
    // 昔つけた魔族ロールが残っている
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]); // 本体と完全に同じ状態
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("初回有効化で正規化できなければ active にせず返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    const row = approved(ctx);
    const w = world({ removeFails: true });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved");
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    expect(w.altRoles).toEqual([MAZOKU_ROLE]); // 魔人を足していない
    ctx.db.close();
  });
});

describe("審査パネルの行数", () => {
  it("**承認待ちが5件以上でも ActionRow は5行を超えない**", async () => {
    const { subAccountReviewPanel, MAX_ACTION_ROWS } = await import("../src/commands/sub-account-admin.js");
    const ctx = setup();
    for (let i = 0; i < 8; i++) {
      const alt = `2222222222222222${String(i).padStart(2, "0")}`;
      ctx.db
        .prepare(
          "INSERT INTO sub_accounts (main_user_id,alt_user_id,status,created_at,updated_at) VALUES (?,?, 'pending', ?, ?)",
        )
        .run(MAIN, alt, i, i);
    }

    const panel = subAccountReviewPanel(ctx.services);

    expect(ctx.subAccounts.countByStatus("pending")).toBe(8);
    expect(panel.components.length).toBeLessThanOrEqual(MAX_ACTION_ROWS);
    // 「← 管理へ」は必ず残る（運営が戻れなくならない）
    const last = panel.components.at(-1)!.toJSON().components[0]!;
    expect(last.custom_id).toBe("shokan:hub");
    expect(String(panel.embeds[0]!.toJSON().description)).toContain("承認待ち 8件");
    ctx.db.close();
  });
});

describe("止まった商品からは申請させない", () => {
  it("販売停止後の古いボタンでは modal を開かない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.shop.updateItem(ctx.item.id, { enabled: 0 }, "staff");
    const p = press(`shop:sub-apply:${ctx.item.id}`, world()) as unknown as {
      showModal: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

    await handleShopButton(p as never, ctx.services);

    expect(p.showModal).not.toHaveBeenCalled();
    expect(contentOf(p.update)).toContain("申請できません");
    ctx.db.close();
  });

  it("**modalを開いたあとに停止されたら、submitしても申請を作らない**", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    ctx.shop.updateItem(ctx.item.id, { enabled: 0 }, "staff");
    const m = press(`shop:sub-input:${ctx.item.id}`, world(), MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.subAccounts.listByMain(MAIN)).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("申請できません");
    ctx.db.close();
  });

  it("`shop:sub_account_item_id` を外したあとも申請を作らない", async () => {
    const { handleShopButton, handleShopModal } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("shop:sub_account_item_id", "", "staff");
    const w = world();
    const p = press(`shop:sub-apply:${ctx.item.id}`, w) as unknown as { showModal: ReturnType<typeof vi.fn> };
    const m = press(`shop:sub-input:${ctx.item.id}`, w, MAIN, {
      fields: { getTextInputValue: () => ALT },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopButton(p as never, ctx.services);
    await handleShopModal(m as never, ctx.services);

    expect(p.showModal).not.toHaveBeenCalled();
    expect(ctx.subAccounts.listByMain(MAIN)).toHaveLength(0);
    ctx.db.close();
  });
});

describe("階級ロール設定の欠損", () => {
  const MAZOKU_ROLE = "role-mazoku";
  const clientOf = (w: ReturnType<typeof world>) => ({ guilds: { fetch: vi.fn(async () => w.guild) } }) as never;
  const failEvents = (ctx: Ctx) =>
    ctx.db.prepare("SELECT payload_json p FROM events WHERE type='sub_account_rank_sync_failed'").all() as Array<{
      p: string;
    }>;

  /** 4つの階級ロールを全部入れた状態を作る（既定では kenma / mazoku が未設定） */
  function fullConfig(ctx: Ctx) {
    ctx.settings.set("role:kenma", "role-kenma", "staff");
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
  }

  it("**設定が欠けていたら、何も remove/add せず失敗として残す**", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup(); // main = 魔人
    fullConfig(ctx);
    ctx.settings.set("role:majin", "", "staff"); // 魔人ロールの設定だけ消える
    ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const w = world();

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(w.alt.roles.remove).not.toHaveBeenCalled();
    expect(w.alt.roles.add).not.toHaveBeenCalled();
    expect(failEvents(ctx)).toHaveLength(1);
    expect(failEvents(ctx)[0]!.p).toContain("role:majin");
    ctx.db.close();
  });

  it("**設定欠損で既存の階級を剥がさない**（設定漏れを「階級なし」と読まない）", async () => {
    const { syncSubAccountRanks } = await import("../src/sub-account-jobs.js");
    const ctx = setup();
    fullConfig(ctx);
    ctx.settings.set("role:kenma", "", "staff"); // 別の階級の設定が欠けているだけ
    ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
    const w = world();
    w.alt.roles.cache.set(MAJIN_ROLE, true);
    w.altRoles.push(MAJIN_ROLE);

    await syncSubAccountRanks(clientOf(w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]); // 剥がされていない
    expect(w.alt.roles.remove).not.toHaveBeenCalled();
    expect(failEvents(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  it("初回有効化でも、設定が欠けていれば active にせず返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    fullConfig(ctx);
    ctx.settings.set("role:mazoku", "", "staff");
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.alt.roles.add).not.toHaveBeenCalled();
    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved");
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    ctx.db.close();
  });
});

describe("有効化に失敗したら階級ロールも元へ戻す", () => {
  const MAZOKU_ROLE = "role-mazoku";

  function conflictOnActivate(ctx: Ctx, rowId: number) {
    // 正規化のあと、契約を始める直前に別経路がさらっていった状況
    vi.spyOn(ctx.subAccounts, "activate").mockImplementationOnce(() => {
      ctx.db.prepare("UPDATE sub_accounts SET status='cancelled' WHERE id=?").run(rowId);
      return false;
    });
  }

  it("**正規化で剥がした元の階級を戻す**（返金したうえで元の魔族に復帰）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup(); // main = 魔人
    ctx.settings.set("role:kenma", "role-kenma", "staff");
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    const row = approved(ctx);
    const w = world();
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);
    conflictOnActivate(ctx, row.id);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([MAZOKU_ROLE]); // 開始前の状態へ戻っている
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    vi.restoreAllMocks();
    ctx.db.close();
  });

  it("**元から持っていた wanted role は剥がさない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("role:kenma", "role-kenma", "staff");
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    const row = approved(ctx);
    const w = world();
    // 最初から魔人を持っている（今回のBotが付けたものではない）
    w.alt.roles.cache.set(MAJIN_ROLE, true);
    w.altRoles.push(MAJIN_ROLE);
    conflictOnActivate(ctx, row.id);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([MAJIN_ROLE]); // 巻き添えで剥がさない
    expect(balance(ctx)).toBe(1_000_000);
    vi.restoreAllMocks();
    ctx.db.close();
  });

  it("戻せたか確認できないときは自動返金しない（処理失敗として人へ）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("role:kenma", "role-kenma", "staff");
    ctx.settings.set("role:mazoku", MAZOKU_ROLE, "staff");
    const row = approved(ctx);
    const w = world();
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);
    conflictOnActivate(ctx, row.id);
    // 正規化までは通し、巻き戻しの確認だけ落とす
    let calls = 0;
    w.guild.members.fetch = vi.fn(async (arg?: unknown) => {
      if (typeof arg === "object" && arg !== null && ++calls > 2) throw new Error("Service Unavailable");
      return w.alt;
    }) as never;

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000 - PRICE); // **返金していない**
    expect(ctx.shop.listUserPurchases(MAIN).filter((p) => p.status === "active")).toHaveLength(1);
    vi.restoreAllMocks();
    ctx.db.close();
  });
});

describe("正規化の途中で失敗したときも副作用を戻す", () => {
  const MAZOKU_ROLE = "role-mazoku";
  const KENMA_ROLE = "role-kenma";

  it("**剥奪後・付与がAPIエラー・最終確認も不能 → 自動返金しない**（払っていないのに階級が残る、を作らない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup(); // main = 魔人
    const row = approved(ctx);
    // 魔族のremoveは成功し、魔人のaddはDiscord側で通るがAPIはエラー。
    // その後の取り直しが落ちて実状態が読めない
    const w = world({ addFails: "Service Unavailable", addActuallyApplies: true, forceFetchFailsAfter: 3 });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000 - PRICE); // **返金していない**
    expect(ctx.shop.listUserPurchases(MAIN).filter((p) => p.status === "active")).toHaveLength(1);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved");
    ctx.db.close();
  });

  it("付与の失敗が確認できるなら、開始前へ戻してから返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ addFails: "Missing Permissions", addFailsFor: MAJIN_ROLE }); // 魔人だけ付かない
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([MAZOKU_ROLE]); // 開始前へ戻っている
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    expect(ctx.subAccounts.get(row.id)!.status).toBe("approved");
    ctx.db.close();
  });

  it("余分なロールの一部しか剥がせなかった場合も、開始前へ戻してから返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    // 魔族と剣魔を持っている。剣魔だけ剥がせない
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.alt.roles.cache.set(KENMA_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE, KENMA_ROLE);
    const realRemove = w.alt.roles.remove;
    w.alt.roles.remove = vi.fn(async (id: string, reason?: string) => {
      if (id === KENMA_ROLE && reason?.includes("本体の階級に合わせる")) return undefined;
      return realRemove(id, reason);
    }) as never;

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect([...w.altRoles].sort()).toEqual([KENMA_ROLE, MAZOKU_ROLE].sort()); // 両方戻っている
    expect(w.altRoles).not.toContain(MAJIN_ROLE); // 魔人は足していない
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    ctx.db.close();
  });

  it("**開始前の状態は古いcacheではなく実体から取る**（持っていなかったロールを新しく付けない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    // cache上は魔族を持っているように見えるが、実体には階級ロールが無い
    const w = world({ staleOnly: [MAZOKU_ROLE] });
    vi.spyOn(ctx.subAccounts, "activate").mockImplementationOnce(() => {
      ctx.db.prepare("UPDATE sub_accounts SET status='cancelled' WHERE id=?").run(row.id);
      return false;
    });

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    expect(w.altRoles).toEqual([]); // 巻き戻しても魔族を新規付与しない
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    vi.restoreAllMocks();
    ctx.db.close();
  });
});

/**
 * **再起動をまたいでも巻き戻しの基準を失わない。**
 *
 * 剥がした直後に落ちると「元は何を持っていたか」がプロセスと一緒に消える。
 * 再試行が取り直すと、剥がしたあとの状態を「開始前」と誤認し、返金したうえで
 * 元の階級を消したままにしてしまう。だから Discord を触る前にDBへ残す。
 */
describe("クラッシュと再起動をまたぐ巻き戻し", () => {
  const MAZOKU_ROLE = "role-mazoku";
  const tmpDb = () => join(mkdtempSync(join(tmpdir(), "sub-crash-")), "bot.db");

  /**
   * 課金済み・未配送の購入を作る。
   *
   * `delivery_state` を明示しておく。NULL のままだと、開き直したときに
   * 「列の導入前からある旧購入」とみなす移行が配送済みへ倒してしまう
   * （本番は移行済みなので起きないが、テストではDBを作った直後に開き直す）。
   */
  function paid(ctx: Ctx, rowId: number) {
    const { purchase } = ctx.shop.purchase({
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
      userId: MAIN,
      itemId: ctx.item.id,
      actor: "t",
      memberRoleIds: [],
      request: { applicationId: rowId },
    });
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='pending' WHERE id=?").run(purchase.id);
    return ctx.shop.getPurchase(purchase.id)!;
  }

  const clientOf = (w: ReturnType<typeof world>) =>
    ({
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => null) },
      channels: { fetch: vi.fn(async () => null) },
    }) as never;

  it("**剥奪後にクラッシュしても、保存した基準へ戻してから返金する**", async () => {
    const { convergePendingSubAccounts } = await import("../src/scheduler-recovery.js");
    const path = tmpDb();
    const first = setup("majin", path);
    const row = approved(first);
    paid(first, row.id);
    const w = world({ addFails: "Missing Permissions", addFailsFor: MAJIN_ROLE });
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    // 1回目: 基準を保存 → 魔族を剥がしたところで落ちる
    const saved = first.subAccounts.saveActivationBaseline(row.id, [MAZOKU_ROLE]);
    expect(saved).toEqual([MAZOKU_ROLE]);
    await w.alt.roles.remove(MAZOKU_ROLE, "crash test");
    expect(w.altRoles).toEqual([]);
    first.db.close();

    // 再起動: 同じDBを開き直す
    const second = reopen(path);
    expect(second.subAccounts.activationBaseline(row.id)).toEqual([MAZOKU_ROLE]);

    await convergePendingSubAccounts(clientOf(w), second.services);

    // **新しく取り直した空集合ではなく、保存した基準へ戻っている**
    expect(w.altRoles).toEqual([MAZOKU_ROLE]);
    expect(second.ledger.balanceOf(`user:${MAIN}`)).toBe(1_000_000); // 返金済み
    expect(second.subAccounts.get(row.id)!.status).toBe("approved");
    second.db.close();
  });

  it("正規化のあと・契約開始の直前に落ちても、再起動後に正しく有効化する", async () => {
    const { convergePendingSubAccounts } = await import("../src/scheduler-recovery.js");
    const path = tmpDb();
    const first = setup("majin", path);
    const row = approved(first);
    paid(first, row.id);
    const w = world();
    // 正規化まで終わっていた状態（魔人が付いている）
    first.subAccounts.saveActivationBaseline(row.id, []);
    await w.alt.roles.add(MAJIN_ROLE, "crash test");
    const addCallsBefore = w.alt.roles.add.mock.calls.length;
    first.db.close();

    const second = reopen(path);
    await convergePendingSubAccounts(clientOf(w), second.services);

    expect(second.subAccounts.get(row.id)!.status).toBe("active");
    expect(w.altRoles).toEqual([MAJIN_ROLE]);
    // 既に合っているので、余計なロール操作をしない
    expect(w.alt.roles.add.mock.calls.length).toBe(addCallsBefore);
    expect(w.alt.roles.remove).not.toHaveBeenCalled();
    // 課金は1回だけ（再収束で買い直さない）
    expect(second.shop.listUserPurchases(MAIN).filter((p) => p.status === "active")).toHaveLength(1);
    expect(second.ledger.balanceOf(`user:${MAIN}`)).toBe(1_000_000 - PRICE);
    second.db.close();
  });

  it("基準を保存する前に失敗すれば、Discordは無傷で安全に返金できる", async () => {
    const { convergePendingSubAccounts } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    ctx.settings.set("role:kenma", "", "staff"); // 設定欠損で基準の保存前に止まる
    const row = approved(ctx);
    paid(ctx, row.id);
    const w = world();
    w.alt.roles.cache.set(MAZOKU_ROLE, true);
    w.altRoles.push(MAZOKU_ROLE);

    await convergePendingSubAccounts(clientOf(w), ctx.services);

    expect(w.alt.roles.add).not.toHaveBeenCalled();
    expect(w.alt.roles.remove).not.toHaveBeenCalled();
    expect(w.altRoles).toEqual([MAZOKU_ROLE]);
    expect(ctx.subAccounts.activationBaseline(row.id)).toBeNull(); // 基準を作っていない
    expect(ctx.ledger.balanceOf(`user:${MAIN}`)).toBe(1_000_000); // 返金済み
    ctx.db.close();
  });

  it("有効化に成功した基準は「処理済み」として残る", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

    const after = ctx.subAccounts.get(row.id)!;
    expect(after.status).toBe("active");
    expect(after.activation_rank_settled_at).not.toBeNull();
    ctx.db.close();
  });

  it("既存データへ推測で基準を生やさない（保存していなければ null のまま）", () => {
    const ctx = setup();
    const row = ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });

    expect(ctx.subAccounts.activationBaseline(row.id)).toBeNull();
    expect(ctx.subAccounts.get(row.id)!.activation_rank_baseline).toBeNull();
    ctx.db.close();
  });
});
