import { ChannelType, Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: { ownerId: "owner-user" } }));

import {
  conversationCourtRestrictionState,
  enforceConversationCourtRestrictionForGuild,
  handleConversationCourtVoiceUpdate,
  isDenCoreTimeActive,
} from "../src/conversation-court.js";

function services(categoryId = "cat", roleIds: Record<string, string[]> = {}) {
  return {
    settings: {
      getString: vi.fn((key: string) => (key === "category:conversation_court_core_block" ? categoryId : undefined)),
      getJson: vi.fn((key: string, fallback: string[]) => roleIds[key] ?? fallback),
    },
    events: { log: vi.fn() },
  };
}

function member(id: string, roles: string[] = [], bot = false) {
  return {
    id,
    user: { bot },
    roles: { cache: new Map(roles.map((role) => [role, { id: role }])) },
    voice: { disconnect: vi.fn(async () => undefined) },
  };
}

function guildFixture(opts: { category?: any; voiceMembers?: any[]; voiceParentId?: string } = {}) {
  const category = opts.category ?? { id: "cat", guildId: "guild", type: ChannelType.GuildCategory };
  const voice = {
    id: "voice",
    guildId: "guild",
    type: ChannelType.GuildVoice,
    parentId: opts.voiceParentId ?? "cat",
    members: new Collection((opts.voiceMembers ?? []).map((m) => [m.id, m])),
  };
  const cache = new Collection<string, any>([
    [category.id, category],
    [voice.id, voice],
  ]);
  return {
    id: "guild",
    channels: {
      cache,
      fetch: vi.fn(async (id?: string) => (id ? (cache.get(id) ?? null) : cache)),
    },
  };
}

describe("conversation court core-time VC restriction", () => {
  it("uses JST Tue/Wed/Fri/Sat/Sun 21:00 <= now < 23:00, excluding Mon/Thu", () => {
    expect(isDenCoreTimeActive(new Date("2026-08-10T12:30:00Z"))).toBe(false);
    expect(isDenCoreTimeActive(new Date("2026-08-11T12:30:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-12T12:30:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-13T12:30:00Z"))).toBe(false);
    expect(isDenCoreTimeActive(new Date("2026-08-14T12:30:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-15T12:30:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-16T12:30:00Z"))).toBe(true);

    expect(isDenCoreTimeActive(new Date("2026-08-11T11:59:00Z"))).toBe(false);
    expect(isDenCoreTimeActive(new Date("2026-08-11T12:00:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-11T13:59:00Z"))).toBe(true);
    expect(isDenCoreTimeActive(new Date("2026-08-11T14:00:00Z"))).toBe(false);
  });

  it("fails safe and logs when the configured target is not a guild category", async () => {
    const svc = services("text") as any;
    const guild = guildFixture({ category: { id: "text", guildId: "guild", type: ChannelType.GuildText } }) as any;

    const state = await conversationCourtRestrictionState(guild, svc, new Date("2026-08-11T12:30:00Z"));
    const result = await enforceConversationCourtRestrictionForGuild(guild, svc, new Date("2026-08-11T12:30:00Z"), "startup");

    expect(state).toEqual({ active: false, reason: "category_not_category", categoryId: "text" });
    expect(result).toMatchObject({ active: false, disconnected: 0, reason: "category_not_category" });
    expect(svc.events.log).toHaveBeenCalledWith("conversation_court_restriction_invalid_category", expect.any(Object));
  });

  it("startup scan disconnects non-admins in target VCs and leaves admins alone", async () => {
    const normal = member("normal");
    const admin = member("admin", ["admin-role"]);
    const svc = services("cat", { "roles:admin": ["admin-role"] }) as any;
    const guild = guildFixture({ voiceMembers: [normal, admin] }) as any;

    const result = await enforceConversationCourtRestrictionForGuild(guild, svc, new Date("2026-08-11T12:30:00Z"), "startup");

    expect(result).toMatchObject({ active: true, disconnected: 1 });
    expect(normal.voice.disconnect).toHaveBeenCalledTimes(1);
    expect(admin.voice.disconnect).not.toHaveBeenCalled();
  });

  it("voice update ignores mute/deaf-only events and disconnects only moves into the target category", async () => {
    const moved = member("moved");
    const svc = services("cat") as any;
    const guild = guildFixture({ voiceMembers: [moved] }) as any;
    const targetChannel = guild.channels.cache.get("voice");

    await handleConversationCourtVoiceUpdate(
      { channelId: "voice" } as any,
      { channelId: "voice", member: moved, guild, channel: targetChannel } as any,
      svc,
      new Date("2026-08-11T12:30:00Z"),
    );
    expect(moved.voice.disconnect).not.toHaveBeenCalled();

    await handleConversationCourtVoiceUpdate(
      { channelId: null } as any,
      { channelId: "voice", member: moved, guild, channel: targetChannel } as any,
      svc,
      new Date("2026-08-11T12:30:00Z"),
    );
    expect(moved.voice.disconnect).toHaveBeenCalledTimes(1);
  });
});
