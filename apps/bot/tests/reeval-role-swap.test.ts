import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { EventLog, Settings, decideRankSync, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 復帰後のロール入れ替えと階級同期の相互作用。
 *
 * 階級同期は「迷霊ロールは通常階級より優先」かつ「`ghost → meirei` は自動同期してよい」で
 * 動く。どちらも通常の降格反映に必要なので変えない。代わりに、**迷霊ロールを外し損ねたまま
 * 亡霊ロールを付ける**という状態を作らないことで、承認した復帰が同期に巻き戻されるのを防ぐ。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";

const reevalModule = import("../src/commands/reeval.js");

const ROLE = { meirei: "r-meirei", ghost: "r-ghost" };
const USER = "1463201396567441441";
const ACTOR = "user:staff";

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  const events = new EventLog(db);
  settings.set("role:meirei", ROLE.meirei, ACTOR);
  settings.set("role:ghost", ROLE.ghost, ACTOR);
  const services = { db, settings, events } as unknown as Services;
  return { db, settings, events, services };
}

/**
 * ロール操作の成否を差し込めるメンバー。
 * `force fetch` は「いまのロール状態」を返す（remove が成功していれば反映済み）。
 */
function world(opts: { roles: string[]; removeFails?: boolean; addFails?: boolean; refetchFails?: boolean; removeSilentlyIgnored?: boolean }) {
  const cache = new Collection(opts.roles.map((r) => [r, { id: r }] as [string, { id: string }]));
  const member = {
    id: USER,
    roles: {
      cache,
      remove: vi.fn(async (id: string) => {
        if (opts.removeFails) throw new Error("Missing Permissions");
        // API は成功を返したのに実際は消えていない、という取りこぼしも再現する
        if (!opts.removeSilentlyIgnored) cache.delete(id);
      }),
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error("Missing Permissions");
        cache.set(id, { id });
      }),
    },
  } as unknown as GuildMember;
  const guild = {
    members: {
      fetch: vi.fn(async () => {
        if (opts.refetchFails) throw new Error("Unknown Member");
        return member;
      }),
    },
  } as unknown as Guild;
  return { guild, member, cache };
}

/** 最終的なロール構成から、階級同期がDBへ何をするかを見る（DB=ghost 前提） */
const syncVerdict = (roles: Collection<string, { id: string }>) =>
  decideRankSync("ghost", {
    ladder: roles.has(ROLE.ghost) ? ["ghost"] : [],
    meirei: roles.has(ROLE.meirei),
  });

describe("復帰後のロール入れ替え", () => {
  it("迷霊の削除に失敗したら、亡霊を付けない（付けると同期が台帳を迷霊へ戻す）", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [ROLE.meirei], removeFails: true });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("迷霊ロールの解除に失敗");
    // 亡霊付与APIを呼んでいない
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(cache.has(ROLE.ghost)).toBe(false);
    // 「迷霊+亡霊」を作っていない＝付与イベントも起きないので同期も走らない
    expect(cache.has(ROLE.meirei)).toBe(true);
  });

  it("削除APIは成功したが実際に消えていない場合も、亡霊を付けない", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [ROLE.meirei], removeSilentlyIgnored: true });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors[0]).toContain("解除後も残っています");
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(cache.has(ROLE.ghost)).toBe(false);
  });

  it("削除後の再取得に失敗しても、亡霊を付けない", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member } = world({ roles: [ROLE.meirei], refetchFails: true });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors[0]).toContain("再取得に失敗");
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("迷霊の削除に成功し亡霊の付与に失敗 → 階級ロール無し。同期はDBを書き戻さない", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [ROLE.meirei], addFails: true });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors[0]).toContain("亡霊ロールの付与に失敗");
    // 迷霊は外れている＝危険な組み合わせにならない
    expect(cache.has(ROLE.meirei)).toBe(false);
    expect(cache.has(ROLE.ghost)).toBe(false);
    // 階級ロールが1つも無い構成は ambiguous。台帳は触られない
    const verdict = syncVerdict(cache);
    expect(verdict.kind).toBe("ambiguous");
    expect(verdict).toMatchObject({ reason: "no_rank_role" });
  });

  it("両方成功 → 亡霊だけになり、同期は noop", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [ROLE.meirei] });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors).toHaveLength(0);
    expect(cache.has(ROLE.meirei)).toBe(false);
    expect(cache.has(ROLE.ghost)).toBe(true);
    expect(syncVerdict(cache).kind).toBe("noop");
  });

  it("もともと迷霊ロールが無ければ、そのまま亡霊を付ける", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [] });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors).toHaveLength(0);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(cache.has(ROLE.ghost)).toBe(true);
    expect(syncVerdict(cache).kind).toBe("noop");
  });

  it("開始時点で迷霊と亡霊の両方を持っていたら、迷霊だけ外して亡霊を残す", async () => {
    const { applyReinstateRoles } = await reevalModule;
    const ctx = setup();
    const { guild, member, cache } = world({ roles: [ROLE.meirei, ROLE.ghost] });

    const { errors } = await applyReinstateRoles(ctx.services, guild, member, USER, ACTOR);

    expect(errors).toHaveLength(0);
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE.meirei);
    // 既に持っているので付与はしない（冪等）
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(cache.has(ROLE.meirei)).toBe(false);
    expect(cache.has(ROLE.ghost)).toBe(true);
    expect(syncVerdict(cache).kind).toBe("noop");
  });
});

describe("避けている状態そのものの確認", () => {
  it("「迷霊 + 亡霊」を作ると、同期は台帳を ghost から meirei へ戻してしまう", () => {
    // これがこの実装が回避している事故。ルール自体は通常の降格反映に必要なので変えない
    const verdict = decideRankSync("ghost", { ladder: ["ghost"], meirei: true });

    expect(verdict).toMatchObject({ kind: "update", from: "ghost", to: "meirei" });
    expect(verdict.anomalies).toContain("meirei_with_ladder:ghost");
  });
});
