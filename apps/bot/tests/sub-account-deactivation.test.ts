import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  Entry,
  EventLog,
  Ledger,
  Settings,
  Shop,
  SubAccounts,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import {
  activeSubAccountPanel,
  handleSubAccountDeactivation,
  subAccountDeactivationConfirm,
} from "../src/commands/sub-account-admin.js";
import { deactivateSubAccount } from "../src/sub-account-deactivation.js";
import { syncSubAccountRanks } from "../src/sub-account-jobs.js";
import type { Services } from "../src/services.js";

registerDefaultTxTypes();

const MAIN = "1463201396567441441";
const ALT = "1463201396567441442";
const LADDER = {
  ghost: "role-ghost",
  majin: "role-majin",
  kenma: "role-kenma",
  mazoku: "role-mazoku",
};

function setup(mainStatus: "majin" | "mazoku" = "majin") {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const entry = new Entry(db, ledger, events, settings);
  const shop = new Shop(db, ledger, events);
  const subAccounts = new SubAccounts(db, events);
  settings.set("guild:main", "g1", "staff");
  for (const [rank, roleId] of Object.entries(LADDER)) settings.set(`role:${rank}`, roleId, "staff");
  const ts = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO souls (user_id,status,joined_at,updated_at) VALUES (?,?,?,?)").run(MAIN, mainStatus, ts, ts);
  ledger.ensureAccount(`user:${MAIN}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${MAIN}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "deactivation-seed",
  });
  const services = { db, events, ledger, settings, entry, shop, subAccounts } as unknown as Services;
  return { db, events, ledger, settings, entry, shop, subAccounts, services };
}

function active(ctx: ReturnType<typeof setup>) {
  return ctx.subAccounts.importExisting({ mainUserId: MAIN, altUserId: ALT, actor: "staff" });
}

function paidActive(ctx: ReturnType<typeof setup>) {
  const item = ctx.shop.createItem(
    { name: "サブ垢追加", price_land: 80_000, kind: "one_shot", delivery: "auto", delivery_kind: "activate_sub_account" },
    "staff",
  );
  const purchase = ctx.shop.purchase({
    expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    itemId: item.id,
    userId: MAIN,
    actor: "test",
    memberRoleIds: [],
    idempotencyKey: "sub-account-paid",
  }).purchase;
  const row = active(ctx);
  ctx.db.prepare("UPDATE sub_accounts SET purchase_id=? WHERE id=?").run(purchase.id, row.id);
  return { row: ctx.subAccounts.get(row.id)!, purchase };
}

function discordWorld(
  initialRoles: string[],
  opts: {
    removeThrows?: boolean;
    removeNoop?: boolean;
    forceFailsAt?: number;
    blockFirstForce?: { entered: () => void; wait: Promise<void> };
    blockForce?: { at: number; entered: () => void; wait: Promise<void>; failAfterWait?: boolean };
  } = {},
) {
  const roles = new Set(initialRoles);
  const cache = new Collection<string, true>();
  const refreshCache = () => {
    cache.clear();
    for (const id of roles) cache.set(id, true);
  };
  refreshCache();
  const member = {
    id: ALT,
    roles: {
      cache,
      remove: vi.fn(async (id: string) => {
        if (opts.removeThrows) throw new Error("Missing Permissions");
        if (!opts.removeNoop) roles.delete(id);
        refreshCache();
      }),
      add: vi.fn(async (id: string) => {
        roles.add(id);
        refreshCache();
      }),
    },
  };
  let forceCalls = 0;
  const fetch = vi.fn(async (arg: unknown) => {
    const force = typeof arg === "object" && arg !== null;
    if (force) {
      forceCalls += 1;
      if (forceCalls === 1 && opts.blockFirstForce) {
        opts.blockFirstForce.entered();
        await opts.blockFirstForce.wait;
      }
      if (opts.blockForce && forceCalls === opts.blockForce.at) {
        opts.blockForce.entered();
        await opts.blockForce.wait;
        if (opts.blockForce.failAfterWait) throw new Error("Discord unavailable");
      }
      if (opts.forceFailsAt === forceCalls) throw new Error("Discord unavailable");
    }
    refreshCache();
    return member;
  });
  const guild = { id: "g1", members: { fetch } };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { guild: guild as never, client: client as never, member, roles, fetch, forceCalls: () => forceCalls };
}

function failedEvents(ctx: ReturnType<typeof setup>) {
  return ctx.db
    .prepare("SELECT payload_json FROM events WHERE type='sub_account_deactivation_failed' ORDER BY id")
    .all() as Array<{ payload_json: string }>;
}

describe("運営によるサブ垢解除", () => {
  it("active + majinは実状態0確認後にcancelし、Land・購入履歴・purchase_idを変えない", async () => {
    const ctx = setup("majin");
    const { row, purchase } = paidActive(ctx);
    const beforeBalance = ctx.ledger.balanceOf(`user:${MAIN}`);
    const w = discordWorld([LADDER.majin]);

    const result = await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(result.ok).toBe(true);
    expect([...w.roles]).toEqual([]);
    expect(ctx.subAccounts.get(row.id)).toMatchObject({ status: "cancelled", purchase_id: purchase.id });
    expect(ctx.ledger.balanceOf(`user:${MAIN}`)).toBe(beforeBalance);
    expect(ctx.shop.getPurchase(purchase.id)).toMatchObject({ status: "active", paid_land: 80_000 });
    ctx.db.close();
  });

  it("active + mazokuを回収してcancelする", async () => {
    const ctx = setup("mazoku");
    const row = active(ctx);
    const w = discordWorld([LADDER.mazoku]);

    expect((await deactivateSubAccount(ctx.services, w.guild, row.id, "staff")).ok).toBe(true);
    expect([...w.roles]).toEqual([]);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("cancelled");
    ctx.db.close();
  });

  it("複数ladder roleが誤って付いていても全て剥がしてcancelする", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.ghost, LADDER.majin, LADDER.kenma, LADDER.mazoku]);

    expect((await deactivateSubAccount(ctx.services, w.guild, row.id, "staff")).ok).toBe(true);
    expect([...w.roles]).toEqual([]);
    expect(w.member.roles.remove).toHaveBeenCalledTimes(4);
    ctx.db.close();
  });

  it("remove失敗ならactiveを維持して失敗eventを残す", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin], { removeThrows: true });

    const result = await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(result).toMatchObject({ ok: false, reason: "discord_failed" });
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(failedEvents(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  it("最初のforce fetchが不能ならDiscordを変更せずactiveを維持する", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin], { forceFailsAt: 1 });

    await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(w.member.roles.remove).not.toHaveBeenCalled();
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(failedEvents(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  it("最終force fetchが不能ならactiveを維持する", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin], { forceFailsAt: 2 });

    await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(failedEvents(ctx)[0]!.payload_json).toContain("実状態");
    ctx.db.close();
  });

  it("final fetchでroleが残っていればactiveを維持する", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin], { removeNoop: true });

    await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect([...w.roles]).toEqual([LADDER.majin]);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(failedEvents(ctx)[0]!.payload_json).toContain(LADDER.majin);
    ctx.db.close();
  });

  it("role設定欠損ならDiscord変更0・active維持", async () => {
    const ctx = setup();
    const row = active(ctx);
    ctx.settings.delete("role:kenma", "staff");
    const w = discordWorld([LADDER.majin]);

    await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.member.roles.remove).not.toHaveBeenCalled();
    expect(ctx.subAccounts.get(row.id)!.status).toBe("active");
    expect(failedEvents(ctx)[0]!.payload_json).toContain("role:kenma");
    ctx.db.close();
  });

  it("legacy purchase_id=nullも解除できる", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin]);

    await deactivateSubAccount(ctx.services, w.guild, row.id, "staff");

    expect(ctx.subAccounts.get(row.id)).toMatchObject({ status: "cancelled", purchase_id: null });
    ctx.db.close();
  });

  it("二重解除は2回目にDiscord副作用もeventも出さない", async () => {
    const ctx = setup();
    const row = active(ctx);
    const w = discordWorld([LADDER.majin]);

    expect((await deactivateSubAccount(ctx.services, w.guild, row.id, "staff")).ok).toBe(true);
    const forceCalls = w.forceCalls();
    const eventCount = (ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='sub_account_deactivated'").get() as { c: number }).c;
    expect(await deactivateSubAccount(ctx.services, w.guild, row.id, "staff")).toMatchObject({ ok: false, reason: "not_active" });

    expect(w.forceCalls()).toBe(forceCalls);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='sub_account_deactivated'").get() as { c: number }).c).toBe(eventCount);
    ctx.db.close();
  });

  it("scheduler競合中も解除leaseを越えてrankを付け直さず、cancelledなら0へ収束する", async () => {
    const ctx = setup("majin");
    const row = active(ctx);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = discordWorld([LADDER.majin], { blockFirstForce: { entered, wait: gate } });

    const deactivating = deactivateSubAccount(ctx.services, w.guild, row.id, "staff");
    await enteredPromise;
    await syncSubAccountRanks(w.client, ctx.services);
    expect(w.member.roles.add).not.toHaveBeenCalled();
    release();
    expect((await deactivating).ok).toBe(true);
    await syncSubAccountRanks(w.client, ctx.services);

    expect(ctx.subAccounts.get(row.id)!.status).toBe("cancelled");
    expect([...w.roles]).toEqual([]);
    expect(w.member.roles.add).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it("leaseを失った古いschedulerはrollbackでprevious rankを再付与しない", async () => {
    const ctx = setup("majin");
    const row = active(ctx);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = discordWorld([LADDER.ghost], {
      blockForce: { at: 2, entered, wait: gate, failAfterWait: true },
    });

    const syncing = syncSubAccountRanks(w.client, ctx.services);
    await enteredPromise;
    expect([...w.roles]).toEqual([]); // schedulerは余分なrankを剥がすところまで進んだ

    ctx.db.prepare("UPDATE sub_account_rank_operations SET expires_at = 0 WHERE sub_account_id = ?").run(row.id);
    expect((await deactivateSubAccount(ctx.services, w.guild, row.id, "staff")).ok).toBe(true);
    expect(ctx.subAccounts.get(row.id)!.status).toBe("cancelled");
    expect([...w.roles]).toEqual([]);

    release();
    await syncing;

    expect(w.member.roles.add).not.toHaveBeenCalled();
    expect(ctx.subAccounts.get(row.id)!.status).toBe("cancelled");
    expect([...w.roles]).toEqual([]);
    ctx.db.close();
  });
});

describe("サブ垢解除UI", () => {
  const customIds = (view: ReturnType<typeof activeSubAccountPanel>) =>
    view.components.flatMap((component) =>
      component.toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : undefined)).filter(Boolean),
    ) as string[];

  it("activeが5件以上でも全ページの任意契約から確認画面へ進め、ActionRowは常に5以下", () => {
    const ctx = setup("majin");
    const rows = [active(ctx)];
    for (let i = 0; i < 5; i++) {
      rows.push(
        ctx.subAccounts.importExisting({
          mainUserId: MAIN,
          altUserId: `24632013965674414${String(i).padStart(2, "0")}`,
          actor: "staff",
        }),
      );
    }

    const first = activeSubAccountPanel(ctx.services, 0);
    const second = activeSubAccountPanel(ctx.services, 1);
    const fifth = rows[4]!;
    expect(customIds(first)).toContain("shokan:sub-active:1");
    expect(customIds(second)).toContain(`shokan:sub-active-view:${fifth.id}:1`);

    for (const [page, row] of [
      [0, rows[1]!],
      [1, rows[5]!],
    ] as const) {
      const confirm = subAccountDeactivationConfirm(ctx.services, row.id, page);
      const fields = confirm.embeds[0]!.toJSON().fields ?? [];
      expect(fields.map((field) => field.name)).toEqual(["本体", "サブ垢", "現在の本体階級"]);
      expect(fields.map((field) => field.value).join("|")).toContain(row.alt_user_id);
      expect(confirm.components[0]!.toJSON().components[0]).toMatchObject({
        custom_id: `shokan:sub-deactivate:${row.id}:${page}`,
      });
    }

    expect(first.components.length).toBeLessThanOrEqual(5);
    expect(second.components.length).toBeLessThanOrEqual(5);
    ctx.db.close();
  });

  it("stale pageは範囲内へ丸め、存在しない・解除済みのstale buttonはDiscordへ触れない", async () => {
    const ctx = setup("majin");
    const row = active(ctx);
    const w = discordWorld([LADDER.majin]);
    ctx.db.prepare("UPDATE sub_accounts SET status='cancelled' WHERE id=?").run(row.id);
    const interaction = {
      user: { id: MAIN },
      guild: w.guild,
      update: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
    };

    const stalePage = activeSubAccountPanel(ctx.services, 999);
    const missing = subAccountDeactivationConfirm(ctx.services, 999_999, 999);
    await handleSubAccountDeactivation(interaction as never, ctx.services, row.id, 999);

    expect(stalePage.components.length).toBeLessThanOrEqual(5);
    expect(customIds(stalePage)).not.toContainEqual(expect.stringContaining("sub-active-view"));
    expect(missing.embeds).toHaveLength(0);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(ctx.subAccounts.get(row.id)!.status).toBe("cancelled");
    ctx.db.close();
  });
});
