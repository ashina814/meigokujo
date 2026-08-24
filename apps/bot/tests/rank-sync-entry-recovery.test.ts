import { Collection } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import type { Services } from "../src/services.js";

const ROLE = {
  ghost: "r-ghost",
  majin: "r-majin",
  kenma: "r-kenma",
  mazoku: "r-mazoku",
  meirei: "r-meirei",
};

function world(
  handleMemberRoleUpdate: ReturnType<typeof vi.fn>,
  opts: { status?: string | null; roles?: string[]; recover?: boolean } = {},
) {
  let status: string | null = opts.status === undefined ? "waiting" : opts.status;
  const cache = new Collection<string, { id: string }>();
  for (const roleId of opts.roles ?? [ROLE.ghost]) cache.set(roleId, { id: roleId });

  const member = {
    id: "u1",
    user: { bot: false },
    roles: { cache },
  } as unknown as GuildMember;
  const guild = {
    members: { fetch: vi.fn(async () => member) },
  } as unknown as Guild;
  Object.assign(member, { guild });

  handleMemberRoleUpdate.mockImplementation(async () => {
    if (opts.recover !== false) status = "ghost";
  });

  const services = {
    settings: {
      getString: vi.fn((key: string) =>
        ({
          "role:ghost": ROLE.ghost,
          "role:majin": ROLE.majin,
          "role:kenma": ROLE.kenma,
          "role:mazoku": ROLE.mazoku,
          "role:meirei": ROLE.meirei,
        })[key],
      ),
    },
    entry: {
      getSoul: vi.fn(() => (status === null ? undefined : { status })),
    },
    evaluation: { syncStatusFromRoles: vi.fn(() => true) },
    events: { log: vi.fn() },
  } as unknown as Services;

  return { guild, member, services };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../src/commands/entry.js");
});

describe("階級再同期による亡霊化取りこぼしの復旧", () => {
  it("運営の明示再同期なら waiting + 亡霊ロールを通常のロール付与処理へ戻す", async () => {
    const handleMemberRoleUpdate = vi.fn();
    vi.doMock("../src/commands/entry.js", () => ({ handleMemberRoleUpdate }));
    const { reconcileMemberRank } = await import("../src/rank-sync.js");
    const { guild, member, services } = world(handleMemberRoleUpdate);

    const outcome = await reconcileMemberRank(guild, services, "u1", "user:admin");

    expect(outcome).toMatchObject({
      kind: "update",
      detail: "entry_recovered",
      from: "waiting",
      to: "ghost",
    });
    expect(handleMemberRoleUpdate).toHaveBeenCalledTimes(1);
    const [before, after] = handleMemberRoleUpdate.mock.calls[0]!;
    expect((before as GuildMember).roles.cache.has(ROLE.ghost)).toBe(false);
    expect(after).toBe(member);
    expect(member.roles.cache.has(ROLE.ghost)).toBe(true);
    expect(services.evaluation.syncStatusFromRoles).not.toHaveBeenCalled();
    expect(services.events.log).toHaveBeenCalledWith(
      "rank_sync_entry_recovered",
      expect.objectContaining({ target: "u1" }),
    );
  });

  it("魂レコードが無い亡霊は推測で新規入城扱いにせず no_soul のまま止める", async () => {
    const handleMemberRoleUpdate = vi.fn();
    vi.doMock("../src/commands/entry.js", () => ({ handleMemberRoleUpdate }));
    const { reconcileMemberRank } = await import("../src/rank-sync.js");
    const { guild, services } = world(handleMemberRoleUpdate, { status: null });

    const outcome = await reconcileMemberRank(guild, services, "u1", "user:admin");

    expect(outcome).toMatchObject({ kind: "no_soul", detail: "no_soul_row" });
    expect(handleMemberRoleUpdate).not.toHaveBeenCalled();
    expect(services.evaluation.syncStatusFromRoles).not.toHaveBeenCalled();
    expect(services.events.log).toHaveBeenCalledWith(
      "rank_sync_ambiguous",
      expect.objectContaining({ target: "u1", payload: { reason: "no_soul_row" } }),
    );
  });

  it("通常入城フローが成立しなければ status を直書きせず ambiguous で止める", async () => {
    const handleMemberRoleUpdate = vi.fn();
    vi.doMock("../src/commands/entry.js", () => ({ handleMemberRoleUpdate }));
    const { reconcileMemberRank } = await import("../src/rank-sync.js");
    const { guild, services } = world(handleMemberRoleUpdate, { recover: false });

    const outcome = await reconcileMemberRank(guild, services, "u1", "user:admin");

    expect(outcome).toMatchObject({
      kind: "ambiguous",
      detail: "entry_recovery_blocked",
      from: "waiting",
      to: "ghost",
    });
    expect(handleMemberRoleUpdate).toHaveBeenCalledTimes(1);
    expect(services.evaluation.syncStatusFromRoles).not.toHaveBeenCalled();
    expect(services.entry.getSoul("u1")?.status).toBe("waiting");
  });

  it("自動同期では waiting → ghost を入城扱いにせず従来どおり曖昧で止める", async () => {
    const handleMemberRoleUpdate = vi.fn();
    vi.doMock("../src/commands/entry.js", () => ({ handleMemberRoleUpdate }));
    const { reconcileMemberRank } = await import("../src/rank-sync.js");
    const { guild, services } = world(handleMemberRoleUpdate);

    const outcome = await reconcileMemberRank(guild, services, "u1", "system:role-sync");

    expect(outcome).toMatchObject({ kind: "ambiguous", from: "waiting", to: "ghost" });
    expect(handleMemberRoleUpdate).not.toHaveBeenCalled();
    expect(services.evaluation.syncStatusFromRoles).not.toHaveBeenCalled();
  });
});
