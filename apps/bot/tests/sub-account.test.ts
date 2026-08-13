import { describe, expect, it, vi } from "vitest";
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
const PRICE = 80_000;
const MAJIN_ROLE = "role-majin";

function setup(mainStatus: "majin" | "meirei" | "ghost" = "majin") {
  const db = openDb(":memory:");
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

type Ctx = ReturnType<typeof setup>;
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${MAIN}`);

function world(
  opts: {
    addFails?: string;
    addActuallyApplies?: boolean;
    removeFails?: boolean;
    /** エラーを返すが、Discord側では剥奪が通っていた */
    removeActuallyApplies?: boolean;
    /** 取り直し（force fetch）が失敗する＝実状態を確認できない */
    forceFetchFails?: boolean;
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
        if (opts.addFails) {
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
  const guild = {
    id: "g1",
    members: {
      fetch: vi.fn(async (arg?: unknown) => {
        if (opts.altMissing) throw new Error("Unknown Member");
        // 取り直し（{ user, force }）だけ失敗させられるようにする
        if (opts.forceFetchFails && typeof arg === "object" && arg !== null) throw new Error("Service Unavailable");
        return alt;
      }),
    },
    roles: { cache: new Collection() },
  };
  return { guild, alt, altRoles };
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
const payId = (ctx: Ctx, appId: number, attempt = "a1") => `shop:sub-pay:${ctx.item.id}:${appId}:${PRICE}:${attempt}`;

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
    ctx.shop.updateItem(ctx.item.id, { price_land: 120_000 }, "staff");

    await handleShopButton(press(payId(ctx, row.id), w), ctx.services);

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
    ctx.shop.purchase({ userId: MAIN, itemId: legacy.id, actor: "t", memberRoleIds: [] });

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
