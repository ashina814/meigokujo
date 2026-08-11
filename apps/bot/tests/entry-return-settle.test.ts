import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import {
  Entry,
  EventLog,
  Evaluation,
  Ledger,
  Returns,
  Settings,
  Tickets,
  decideRankSync,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 出戻りの確定とロール整合。
 *
 * 二重クリック・複数運営の同時操作・古いチケットからの操作で二重確定しないこと、
 * ロールが部分的に失敗しても階級同期が台帳を逆へ巻き戻さないことを押さえる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const returnModule = import("../src/commands/entry-return.js");

const ROLE = { ghost: "r-ghost", majin: "r-majin", kenma: "r-kenma", mazoku: "r-mazoku", meirei: "r-meirei", wait: "r-wait" };
const USER = "1463201396567441441";
const THREAD = "t-return";
const STAFF = "user:staff";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  const tickets = new Tickets(db, events);
  for (const [k, v] of [
    ["role:ghost", ROLE.ghost],
    ["role:majin", ROLE.majin],
    ["role:kenma", ROLE.kenma],
    ["role:mazoku", ROLE.mazoku],
    ["role:meirei", ROLE.meirei],
    ["role:queue_wait", ROLE.wait],
  ] as const) {
    settings.set(k, v, STAFF);
  }
  const services = { db, ledger, settings, events, entry, evaluation, returns, tickets } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, returns, tickets, services };
}

/** 退出して戻ってきた人 + 出戻り申請チケット */
function returnee(ctx: ReturnType<typeof setup>) {
  ctx.entry.recordJoin(USER);
  ctx.entry.ghostify(USER, STAFF);
  ctx.evaluation.promoteToMajin(USER, STAFF);
  ctx.returns.recordDeparture(USER);
  ctx.returns.markReturnedToWaiting(USER, null);
  ctx.tickets.create(THREAD, USER, "return", { id: "return", name: "出戻り申請", notifyRoleIds: [], staffRoleIds: [] });
}

function guildWith(opts: { roles: string[]; removeFails?: string[]; addFails?: boolean; refetchFails?: boolean }) {
  const cache = new Collection(opts.roles.map((r) => [r, { id: r }] as [string, { id: string }]));
  const member = {
    id: USER,
    roles: {
      cache,
      remove: vi.fn(async (id: string) => {
        if (opts.removeFails?.includes(id)) throw new Error("Missing Permissions");
        cache.delete(id);
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

/** 最終的なロール構成から、階級同期がDBへ何をするか */
const syncVerdict = (roles: Collection<string, { id: string }>, dbStatus: "ghost" | "majin" | "meirei") =>
  decideRankSync(dbStatus, {
    ladder: (["ghost", "majin", "kenma", "mazoku"] as const).filter((r) => roles.has(ROLE[r])),
    meirei: roles.has(ROLE.meirei),
  });

const settleInput = (target: "ghost" | "majin" | "meirei" | "waiting") => ({
  threadId: THREAD,
  targetId: USER,
  target,
  actor: STAFF,
  reason: "テスト",
  evidence: { reason: "テスト" },
});

describe("確定の二重実行と競合", () => {
  it("二度目の確定は空振りし、評価サイクルも1つだけ", async () => {
    const { settleReturn } = await returnModule;
    const ctx = setup();
    returnee(ctx);

    const first = settleReturn(ctx.services, settleInput("ghost"));
    const second = settleReturn(ctx.services, settleInput("ghost"));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(ctx.events.listByType("entry_return_reinstated")).toHaveLength(1);
    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
  });

  it("別の運営が先に別の戻し先で確定していたら、後続は何もしない", async () => {
    const { settleReturn } = await returnModule;
    const ctx = setup();
    returnee(ctx);

    expect(settleReturn(ctx.services, settleInput("majin")).ok).toBe(true);
    const late = settleReturn(ctx.services, settleInput("ghost"));

    expect(late.ok).toBe(false);
    expect(ctx.entry.getSoul(USER)!.status).toBe("majin");
    expect(ctx.entry.getSoul(USER)!.eval_deadline_at).toBeNull();
  });

  it("既に閉じたチケット（古い画面）からは確定できない", async () => {
    const { settleReturn } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    ctx.tickets.close(THREAD, STAFF);

    const result = settleReturn(ctx.services, settleInput("ghost"));

    expect(result).toEqual({ ok: false, reason: "ticket_closed" });
    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting");
  });

  it("確定すると台帳とチケットが同じトランザクションで揃う", async () => {
    const { settleReturn } = await returnModule;
    const ctx = setup();
    returnee(ctx);

    settleReturn(ctx.services, settleInput("ghost"));

    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
    expect(ctx.tickets.get(THREAD)!.status).toBe("closed");
  });

  it("「今回は戻さない」でも台帳は動かず、チケットだけ閉じる", async () => {
    const { settleReturn } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER);

    const result = settleReturn(ctx.services, settleInput("waiting"));

    expect(result.ok).toBe(true);
    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER)).toEqual(before);
    expect(ctx.tickets.get(THREAD)!.status).toBe("closed");
    expect(ctx.events.listByType("entry_return_declined")).toHaveLength(1);
  });
});

describe("ロールの部分失敗", () => {
  it("余分な迷霊ロールを外せなければ、目標ロールを付けない", async () => {
    const { applyReturnRoles } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    // 迷霊ロールが残ったまま亡霊を付けると、同期が台帳を meirei へ巻き戻す
    const { guild, member, cache } = guildWith({ roles: [ROLE.meirei, ROLE.wait], removeFails: [ROLE.meirei] });

    const errors = await applyReturnRoles(ctx.services, guild, member, USER, "ghost", STAFF);

    expect(errors[0]).toContain("解除に失敗");
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(cache.has(ROLE.ghost)).toBe(false);
    expect(cache.has(ROLE.meirei)).toBe(true);
  });

  it("解除後の再取得に失敗しても目標ロールを付けない", async () => {
    const { applyReturnRoles } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const { guild, member, cache } = guildWith({ roles: [ROLE.meirei], refetchFails: true });

    const errors = await applyReturnRoles(ctx.services, guild, member, USER, "ghost", STAFF);

    expect(errors[0]).toContain("再取得に失敗");
    expect(cache.has(ROLE.ghost)).toBe(false);
  });

  it("目標ロールの付与だけ失敗した場合は階級ロール無しで止まり、同期は台帳を触らない", async () => {
    const { applyReturnRoles } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const { guild, member, cache } = guildWith({ roles: [ROLE.meirei], addFails: true });

    const errors = await applyReturnRoles(ctx.services, guild, member, USER, "ghost", STAFF);

    expect(errors[0]).toContain("付与に失敗");
    expect(cache.has(ROLE.meirei)).toBe(false); // 危険な組み合わせを作らない
    expect(cache.has(ROLE.ghost)).toBe(false);
    const verdict = syncVerdict(cache, "ghost");
    expect(verdict.kind).toBe("ambiguous");
    expect(verdict).toMatchObject({ reason: "no_rank_role" });
  });

  it("すべて成功すると目標ロールだけになり、同期は noop", async () => {
    const { applyReturnRoles } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const { guild, member, cache } = guildWith({ roles: [ROLE.meirei, ROLE.majin, ROLE.wait] });

    const errors = await applyReturnRoles(ctx.services, guild, member, USER, "ghost", STAFF);

    expect(errors).toEqual([]);
    expect(cache.has(ROLE.ghost)).toBe(true);
    expect(cache.has(ROLE.meirei)).toBe(false);
    expect(cache.has(ROLE.majin)).toBe(false);
    expect(cache.has(ROLE.wait)).toBe(false); // 案内待ちも外す
    expect(syncVerdict(cache, "ghost").kind).toBe("noop");
  });

  it("迷霊で戻すときも通常階級を先に外してから付ける", async () => {
    const { applyReturnRoles } = await returnModule;
    const ctx = setup();
    returnee(ctx);
    const { guild, member, cache } = guildWith({ roles: [ROLE.majin, ROLE.wait] });

    const errors = await applyReturnRoles(ctx.services, guild, member, USER, "meirei", STAFF);

    expect(errors).toEqual([]);
    expect(cache.has(ROLE.majin)).toBe(false);
    expect(cache.has(ROLE.meirei)).toBe(true);
    expect(syncVerdict(cache, "meirei").kind).toBe("noop");
  });

  it("避けている状態: 迷霊と亡霊が同居すると同期が台帳を巻き戻す", () => {
    const cache = new Collection([
      [ROLE.ghost, { id: ROLE.ghost }],
      [ROLE.meirei, { id: ROLE.meirei }],
    ]);
    expect(syncVerdict(cache, "ghost")).toMatchObject({ kind: "update", from: "ghost", to: "meirei" });
  });
});
