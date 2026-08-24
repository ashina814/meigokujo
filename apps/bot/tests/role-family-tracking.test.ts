import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client, Guild, GuildMember, PartialGuildMember } from "discord.js";
import { Departments, Ledger, RoleFamilyTemporal, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  refreshRoleFamilyGuildSnapshot,
  resetRoleFamilyTrackingForTesting,
  resumeRoleFamilyShard,
  suspendRoleFamilyShard,
  trackRoleFamilyMemberAdd,
  trackRoleFamilyMemberRemove,
  trackRoleFamilyMemberUpdate,
} from "../src/role-family-tracking.js";

const BASE = 2_000_000_000;
const worlds: Services[] = [];
afterEach(() => {
  for (const services of worlds.splice(0)) resetRoleFamilyTrackingForTesting(services);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function world() {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('guild:main', 'main', 1)`).run();
  const departments = new Departments(db, new Ledger(db));
  departments.upsert("dept-a", "A", "role-a");
  const roleFamilyTemporal = new RoleFamilyTemporal(db);
  const services = {
    db,
    departments,
    roleFamilyTemporal,
    settings: { getString: (key: string) => key === "guild:main" ? "main" : null },
  } as unknown as Services;
  worlds.push(services);
  return { db, services };
}

function member(guild: Guild, id: string, roles: readonly string[], bot = false): GuildMember {
  return {
    id,
    guild,
    user: { bot },
    roles: { cache: new Map(roles.map((role) => [role, { id: role }])) },
  } as unknown as GuildMember;
}

function guildWith(fetch: ReturnType<typeof vi.fn>, id = "main", shardId = 0): Guild {
  return {
    id,
    shardId,
    available: true,
    members: { fetch },
  } as unknown as Guild;
}

describe("trusted Discord role observation wiring", () => {
  it("J. startup full fetch完了時刻からだけopenし、fetch待ち時間をbackfillしない", async () => {
    const { db, services } = world();
    const pending = deferred<Map<string, GuildMember>>();
    const fetch = vi.fn(() => pending.promise);
    const guild = guildWith(fetch);
    const alice = member(guild, "alice", ["role-a"]);
    const times = [BASE, BASE + 30];
    const run = refreshRoleFamilyGuildSnapshot(guild, services, () => times.shift()!);
    expect(db.prepare(`SELECT COUNT(*) FROM role_family_member_presence`).pluck().get()).toBe(0);
    pending.resolve(new Map([[alice.id, alice]]));
    await run;
    expect(db.prepare(`SELECT started_at FROM role_family_member_presence`).pluck().get()).toBe(BASE + 30);
  });

  it("M. shard disconnectからresume full fetch completionまでUNKNOWNでgapを埋めない", async () => {
    const { db, services } = world();
    const fetch = vi.fn();
    const guild = guildWith(fetch);
    const alice = member(guild, "alice", ["role-a"]);
    fetch.mockResolvedValue(new Map([[alice.id, alice]]));
    await refreshRoleFamilyGuildSnapshot(guild, services, () => BASE);
    const client = { guilds: { cache: new Map([[guild.id, guild]]) } } as unknown as Client;
    expect(suspendRoleFamilyShard(client, 0, services, () => BASE + 10)).toBe(true);
    await resumeRoleFamilyShard(client, 0, services, undefined, () => BASE + 40);
    expect(db.prepare(
      `SELECT started_at, ended_at FROM role_family_member_presence ORDER BY id`,
    ).all()).toEqual([
      { started_at: BASE, ended_at: BASE + 10 },
      { started_at: BASE + 40, ended_at: null },
    ]);
  });

  it("M2. disconnect前に開始したin-flight fetchはresume後のcoverageを再openしない", async () => {
    const { db, services } = world();
    const stale = deferred<Map<string, GuildMember>>();
    const fresh = deferred<Map<string, GuildMember>>();
    const fetch = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const guild = guildWith(fetch);
    const alice = member(guild, "alice", ["role-a"]);
    const first = refreshRoleFamilyGuildSnapshot(guild, services, () => BASE);
    const client = { guilds: { cache: new Map([[guild.id, guild]]) } } as unknown as Client;

    expect(suspendRoleFamilyShard(client, 0, services, () => BASE + 10)).toBe(false);
    const resumeTimes = [BASE + 20, BASE + 40];
    const resumed = resumeRoleFamilyShard(client, 0, services, undefined, () => resumeTimes.shift()!);
    expect(fetch).toHaveBeenCalledTimes(2);

    stale.resolve(new Map([[alice.id, alice]]));
    await expect(first).resolves.toBe(false);
    expect(db.prepare(`SELECT COUNT(*) FROM role_family_member_presence`).pluck().get()).toBe(0);

    fresh.resolve(new Map([[alice.id, alice]]));
    await expect(resumed).resolves.toBe(true);
    expect(db.prepare(`SELECT started_at FROM role_family_member_presence`).pluck().all()).toEqual([BASE + 40]);
  });

  it("N. partial oldMemberはentry handler returnと独立してpriorをcloseし、forced fetch後だけre-anchorする", async () => {
    const { db, services } = world();
    const fetch = vi.fn();
    const guild = guildWith(fetch);
    const alice = member(guild, "alice", ["role-a"]);
    fetch.mockResolvedValueOnce(new Map([[alice.id, alice]]));
    await refreshRoleFamilyGuildSnapshot(guild, services, () => BASE);
    fetch.mockResolvedValueOnce(alice);
    const oldPartial = { id: "alice", guild, user: { bot: false }, partial: true } as unknown as PartialGuildMember;
    const times = [BASE + 10, BASE + 20];
    await trackRoleFamilyMemberUpdate(oldPartial, alice, services, () => times.shift()!);
    expect(fetch).toHaveBeenLastCalledWith({ user: "alice", force: true });
    expect(db.prepare(
      `SELECT started_at, ended_at, end_reason FROM role_family_member_presence ORDER BY id`,
    ).all()).toEqual([
      { started_at: BASE, ended_at: BASE + 10, end_reason: "member_unknown" },
      { started_at: BASE + 20, ended_at: null, end_reason: null },
    ]);
  });

  it("O/P/Q/R. main human add/removeだけを扱い、botとother guildをevidenceにしない", async () => {
    const { db, services } = world();
    const fetch = vi.fn().mockResolvedValue(new Map());
    const main = guildWith(fetch);
    const other = guildWith(vi.fn().mockResolvedValue(new Map()), "other");
    await refreshRoleFamilyGuildSnapshot(main, services, () => BASE);
    expect(trackRoleFamilyMemberAdd(member(main, "alice", ["role-a"]), services, () => BASE + 10)).toBe(true);
    expect(trackRoleFamilyMemberAdd(member(main, "bot", ["role-a"], true), services, () => BASE + 11)).toBe(true);
    expect(trackRoleFamilyMemberAdd(member(other, "outsider", ["role-a"]), services, () => BASE + 12)).toBe(false);
    expect(trackRoleFamilyMemberRemove(member(main, "alice", []), services, () => BASE + 20)).toBe(true);
    expect(db.prepare(`SELECT DISTINCT user_id FROM role_family_member_presence`).pluck().all()).toEqual(["alice"]);
  });
});
