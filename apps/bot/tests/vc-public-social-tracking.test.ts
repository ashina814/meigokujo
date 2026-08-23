import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { openDb, Settings, VcPublicSocialPresence } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  initializeVcPublicSocialPresence,
  isEligiblePublicSocialVoiceChannel,
  trackVcPublicSocialChannelUpdate,
  trackVcPublicSocialEveryoneRoleUpdate,
  trackVcPublicSocialPresence,
} from "../src/vc-public-social-tracking.js";

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  settings.set("guild:main", "guild-main", "test");
  const vcPublicSocial = new VcPublicSocialPresence(db);
  const services = { settings, vcPublicSocial } as unknown as Services;
  return { db, settings, vcPublicSocial, services };
}

function guild(id = "guild-main") {
  const everyone = { id: `${id}-everyone` };
  return {
    id,
    roles: { everyone },
    channels: { cache: new Collection<string, never>() },
  };
}

function channel(options: {
  id?: string;
  guild?: ReturnType<typeof guild>;
  type?: ChannelType;
  view?: boolean | null;
  connect?: boolean | null;
  permissionThrows?: boolean;
  humans?: string[];
  bots?: string[];
  parentId?: string | null;
} = {}) {
  const owner = options.guild ?? guild();
  const members = new Collection<string, { id: string; user: { bot: boolean } }>();
  for (const id of options.humans ?? []) members.set(id, { id, user: { bot: false } });
  for (const id of options.bots ?? []) members.set(id, { id, user: { bot: true } });
  const value = {
    id: options.id ?? "voice-public",
    guildId: owner.id,
    guild: owner,
    type: options.type ?? ChannelType.GuildVoice,
    parentId: options.parentId ?? null,
    members,
    permissionsFor: () => {
      if (options.permissionThrows) throw new Error("permission resolution failed");
      if (options.view === null || options.connect === null) return null;
      return new PermissionsBitField([
        ...(options.view === false ? [] : [PermissionFlagsBits.ViewChannel]),
        ...(options.connect === false ? [] : [PermissionFlagsBits.Connect]),
      ]);
    },
  };
  owner.channels.cache.set(value.id, value as never);
  return value;
}

function state(value: ReturnType<typeof channel> | null) {
  return { channel: value, channelId: value?.id ?? null } as never;
}

function rows(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT user_id, channel_id, started_at, ended_at, end_quality FROM vc_public_social_presence ORDER BY id").all() as Array<Record<string, unknown>>;
}

describe("public VC eligibility", () => {
  it("main GuildVoice + @everyone ViewChannel/Connectだけを許可する", () => {
    const { services } = setup();
    expect(isEligiblePublicSocialVoiceChannel(channel() as never, services)).toBe(true);
    expect(isEligiblePublicSocialVoiceChannel(channel({ type: ChannelType.GuildStageVoice }) as never, services)).toBe(false);
    expect(isEligiblePublicSocialVoiceChannel(channel({ guild: guild("other-guild") }) as never, services)).toBe(false);
  });

  it.each([
    ["role-gated oboro", { id: "oboro", view: false }],
    ["role-gated mitsu", { id: "mitsu", connect: false }],
    ["permission unknown", { view: null, connect: null }],
    ["permission failure", { permissionThrows: true }],
  ])("%sをfail-closedする", (_label, options) => {
    const { services } = setup();
    expect(isEligiblePublicSocialVoiceChannel(channel(options) as never, services)).toBe(false);
  });
});

describe("VoiceStateUpdate reconciliation", () => {
  it("Alice alone→Bob join→Bob leaveをjoin/leave時刻で双方10秒にする", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 100);
    voice.members.set("bob", { id: "bob", user: { bot: false } });
    trackVcPublicSocialPresence(state(voice), state(voice), services, () => 110);
    voice.members.delete("bob");
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 120);
    expect(rows(db)).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 110, ended_at: 120, end_quality: "observed" },
      { user_id: "bob", channel_id: "voice-public", started_at: 110, ended_at: 120, end_quality: "observed" },
    ]);
  });

  it("3 humans + botでもhuman 3 rowsだけでpair-sumを作らない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob", "carol"], bots: ["music-bot"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    voice.members.clear();
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 20);
    expect(rows(db)).toHaveLength(3);
    expect(rows(db).map((row) => row.user_id).sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("same-channel mute/deafen相当のstate updateでintervalを分割しない", () => {
    const { db, services } = setup();
    const voice = channel({ humans: ["alice", "bob"] });
    trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    trackVcPublicSocialPresence(state(voice), state(voice), services, () => 15);
    voice.members.clear();
    trackVcPublicSocialPresence(state(voice), state(null), services, () => 20);
    expect(rows(db).filter((row) => row.user_id === "alice")).toEqual([
      { user_id: "alice", channel_id: "voice-public", started_at: 10, ended_at: 20, end_quality: "observed" },
    ]);
  });

  it("Alice + botはsocial occupancyにならない", () => {
    const { db, services } = setup();
    trackVcPublicSocialPresence(state(null), state(channel({ humans: ["alice"], bots: ["bot"] })), services, () => 10);
    expect(rows(db)).toEqual([]);
  });

  it("other guild / non-GuildVoice / private permissionは0 row", () => {
    const { db, services } = setup();
    for (const voice of [
      channel({ guild: guild("other"), humans: ["alice", "bob"] }),
      channel({ type: ChannelType.GuildStageVoice, humans: ["alice", "bob"] }),
      channel({ id: "oboro", view: false, humans: ["alice", "bob"] }),
      channel({ id: "mitsu", connect: false, humans: ["alice", "bob"] }),
    ]) trackVcPublicSocialPresence(state(null), state(voice), services, () => 10);
    expect(rows(db)).toEqual([]);
  });
});

describe("permission transitions / restart / isolation", () => {
  it("voice public→private→public transitionをChannelUpdateでclose/reopenする", () => {
    const { db, services } = setup();
    const owner = guild();
    const publicVoice = channel({ guild: owner, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(publicVoice as never, services, () => 10);
    const privateVoice = channel({ id: publicVoice.id, guild: owner, view: false, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(privateVoice as never, services, () => 20);
    const publicAgain = channel({ id: publicVoice.id, guild: owner, humans: ["alice", "bob"] });
    trackVcPublicSocialChannelUpdate(publicAgain as never, services, () => 30);
    publicAgain.members.clear();
    trackVcPublicSocialChannelUpdate(publicAgain as never, services, () => 40);
    expect(rows(db).filter((row) => row.user_id === "alice")).toMatchObject([
      { started_at: 10, ended_at: 20 },
      { started_at: 30, ended_at: 40 },
    ]);
  });

  it("category updateと@everyone role updateでchild voiceを再収束する", () => {
    const { db, services } = setup();
    const owner = guild();
    const child = channel({ guild: owner, parentId: "category", humans: ["alice", "bob"] });
    const category = channel({ id: "category", guild: owner, type: ChannelType.GuildCategory });
    expect(trackVcPublicSocialChannelUpdate(category as never, services, () => 10)).toBe(true);
    const role = { id: owner.roles.everyone.id, guild: owner };
    expect(trackVcPublicSocialEveryoneRoleUpdate(role as never, services, () => 20)).toBe(true);
    expect(rows(db)).toHaveLength(2);
    expect(child.id).toBe("voice-public");
  });

  it("startupはmain guild cacheだけから現在観測を開始しfetch/backfillしない", () => {
    const { db, services } = setup();
    const owner = guild();
    channel({ guild: owner, humans: ["alice", "bob"] });
    const fetch = vi.fn();
    const client = { guilds: { cache: new Collection([[owner.id, owner]]), fetch } };
    expect(initializeVcPublicSocialPresence(client as never, services, () => 100)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(2);
  });

  it("sidecar writer failureをcatchし既存voice処理へthrowしない", () => {
    const { services } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const legacy = vi.fn();
    vi.spyOn(services.vcPublicSocial, "reconcileChannel").mockImplementation(() => { throw new Error("disk failed"); });
    expect(trackVcPublicSocialPresence(state(null), state(channel({ humans: ["alice", "bob"] })), services, () => 10)).toBe(false);
    legacy();
    expect(legacy).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[vc-public-social] voice observation failed", expect.any(Error));
    error.mockRestore();
  });
});
